// Creates functions at the addresses listed (one hexadecimal address per line) in <dir>/<program>.seeds, where <dir>
// is the first argument and <program> the imported file name without extension.
// Runs before auto-analysis so that recursive descent starts from every known entry point.

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;

import java.nio.file.Files;
import java.nio.file.Paths;

public class SeedFunctions extends GhidraScript {
	@Override
	protected void run() throws Exception {
		String[] args = getScriptArgs();
		String stem = currentProgram.getName().replaceAll("[.]elf$", "");
		java.nio.file.Path seeds = args.length < 1 ? null : Paths.get(args[0], stem + ".seeds");
		if (seeds == null || !Files.exists(seeds)) {
			println("SeedFunctions: no seed file for " + stem);
			return;
		}
		int made = 0;
		for (String line : Files.readAllLines(seeds)) {
			line = line.trim();
			if (line.isEmpty()) {
				continue;
			}
			Address a = toAddr(Long.parseLong(line, 16));
			if (a == null || !currentProgram.getMemory().contains(a)) {
				continue;
			}
			if (getFunctionAt(a) == null) {
				disassemble(a);
				if (createFunction(a, null) != null) {
					made++;
				}
			}
		}
		println("SeedFunctions: created " + made + " functions");
	}
}
