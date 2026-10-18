"""Runs the realesr-animevideov3 x2 model over every PNG of a folder with numpy, reading the ncnn files of its official release.

usage: python -I model_run.py <model.param> <model.bin> <in dir> <out dir>

The network is the one its param file lists (Real-ESRGAN's compact SRVGG): a 3x3 convolution with 64 channels and a PReLU, repeated, then a 3x3
convolution to 48 channels, a pixel shuffle by 4, the sum with the nearest-neighbour x4 of the input, and a bicubic halving. The param file is
checked against that shape, and the weights are read from the bin file in the order ncnn stores them (a 4-byte type tag before each convolution's
half-float weights, then float bias; PReLU slopes). Written because the ncnn Python package gave different, partly garbage output on every run of this model.
"""
import os
import re
import struct
import sys

import numpy as np
from PIL import Image


FLOAT16_TAG = 0x01306B47  # ncnn's marker for weights stored as half floats


def load(param_path, bin_path):
    lines = open(param_path).read().split("\n")[2:]
    data = open(bin_path, "rb").read()
    at = 0
    layers = []
    for line in lines:
        words = line.split()
        if not words:
            continue
        kind = words[0]
        attrs = {int(k): v for k, v in (w.split("=") for w in words[4 + int(words[2]) + int(words[3]):])}
        if kind == "Convolution":
            out, k, size = int(attrs[0]), int(attrs[1]), int(attrs[6])
            assert attrs.get(4) == "1" and attrs.get(5) == "1" and size % (out * k * k) == 0
            (tag,) = struct.unpack_from("<I", data, at)
            assert tag == FLOAT16_TAG, "weights are not float16"
            w = np.frombuffer(data, "<f2", size, at + 4).astype(np.float32).reshape(out, size // (out * k * k), k, k)
            at += 4 + (size * 2 + 3) // 4 * 4
            b = np.frombuffer(data, "<f4", out, at)
            at += out * 4
            layers.append(("conv", w, b))
        elif kind == "PReLU":
            n = int(attrs[0])
            layers.append(("prelu", np.frombuffer(data, "<f4", n, at)))
            at += n * 4
        else:
            layers.append((kind,))
    assert at == len(data), "the bin file has data the param file does not account for"
    kinds = [l[0] for l in layers]
    assert kinds[:2] == ["Input", "Split"] and kinds[-4:] == ["PixelShuffle", "Interp", "BinaryOp", "Interp"], kinds
    return [l for l in layers if l[0] in ("conv", "prelu")]


def conv(x, w, b):
    h, wd, c = x.shape
    padded = np.pad(x, ((1, 1), (1, 1), (0, 0)))
    cols = np.concatenate([padded[dy:dy + h, dx:dx + wd, :] for dy in range(3) for dx in range(3)], axis=2).reshape(h * wd, 9 * c)
    kernel = w.transpose(2, 3, 1, 0).reshape(9 * c, -1)
    return (cols @ kernel + b).reshape(h, wd, -1)


def cubic_weights(t, a=-0.75):
    def f(d):
        d = abs(d)
        return np.where(d <= 1, ((a + 2) * d - (a + 3)) * d * d + 1, np.where(d < 2, (((d - 5) * d + 8) * d - 4) * a, 0.0))
    return np.stack([f(1 + t), f(t), f(1 - t), f(2 - t)], axis=-1)


def halve_bicubic(x):
    """Bicubic resize by 0.5 (output pixel centres map to input positions 2 * i + 0.5), edges clamped."""
    for axis in (0, 1):
        n = x.shape[axis] // 2
        pos = np.arange(n) * 2 + 0.5
        base = np.floor(pos).astype(int)
        weights = cubic_weights(pos - base)
        taps = [np.take(x, np.clip(base + o, 0, x.shape[axis] - 1), axis=axis) for o in (-1, 0, 1, 2)]
        shape = [1, 1, 1]
        shape[axis] = n
        x = sum(t * weights[:, i].reshape(shape) for i, t in enumerate(taps))
    return x


def run(layers, image):
    x = image.astype(np.float32) / 255.0
    y = x
    convs = [l for l in layers if l[0] == "conv"]
    slopes = [l for l in layers if l[0] == "prelu"]
    for i, (_, w, b) in enumerate(convs):
        y = conv(y, w, b)
        if i < len(slopes):
            y = np.where(y >= 0, y, y * slopes[i][1])
    h, w_, _ = y.shape
    shuffled = y.reshape(h, w_, 3, 4, 4).transpose(0, 3, 1, 4, 2).reshape(h * 4, w_ * 4, 3)
    full = shuffled + np.repeat(np.repeat(x, 4, axis=0), 4, axis=1)
    return np.clip(halve_bicubic(full) * 255.0 + 0.5, 0, 255).astype(np.uint8)


def main():
    param, weights, src, dst = sys.argv[1:5]
    layers = load(param, weights)
    for name in sorted(os.listdir(src)):
        if name.endswith(".png"):
            rgb = np.asarray(Image.open(os.path.join(src, name)).convert("RGB"))
            Image.fromarray(run(layers, rgb), "RGB").save(os.path.join(dst, name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
