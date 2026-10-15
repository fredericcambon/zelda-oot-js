// Writes what Ghidra found in the program as JSON: functions (with their address ranges), indirect jumps and
// calls with the targets Ghidra resolved, and the ranges it turned into data. Argument 1 is the output directory; the file is <program>.json.

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressRange;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.lang.Register;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.FlowType;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;

import java.io.PrintWriter;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

public class ExportFacts extends GhidraScript {
	@Override
	protected void run() throws Exception {
		String[] args = getScriptArgs();
		String stem = currentProgram.getName().replaceAll("[.]elf$", "");
		String path = Paths.get(args[0], stem + ".json").toString();
		try (PrintWriter w = new PrintWriter(path, "UTF-8")) {
			w.println("{");
			w.println("\"language\": \"" + currentProgram.getLanguageID() + "\",");

			w.println("\"functions\": [");
			FunctionIterator fit = currentProgram.getFunctionManager().getFunctions(true);
			boolean first = true;
			while (fit.hasNext()) {
				Function f = fit.next();
				AddressSetView body = f.getBody();
				StringBuilder ranges = new StringBuilder();
				for (AddressRange r : body.getAddressRanges()) {
					if (ranges.length() > 0) {
						ranges.append(",");
					}
					ranges.append("[").append(r.getMinAddress().getOffset()).append(",").append(r.getMaxAddress().getOffset() + 1).append("]");
				}
				w.print((first ? "" : ",\n") + "{\"start\":" + f.getEntryPoint().getOffset() + ",\"ranges\":[" + ranges + "],\"thunk\":" + f.isThunk() + "}");
				first = false;
			}
			w.println("\n],");

			w.println("\"indirect\": [");
			first = true;
			InstructionIterator iit = currentProgram.getListing().getInstructions(true);
			while (iit.hasNext()) {
				Instruction ins = iit.next();
				FlowType ft = ins.getFlowType();
				if (!ft.isComputed()) {
					continue;
				}
				Register reg = ins.getRegister(0);
				List<String> targets = new ArrayList<>();
				for (Reference ref : ins.getReferencesFrom()) {
					RefType rt = ref.getReferenceType();
					if (rt.isFlow() && ref.getToAddress().isMemoryAddress()) {
						targets.add(String.valueOf(ref.getToAddress().getOffset()));
					}
				}
				w.print((first ? "" : ",\n") + "{\"addr\":" + ins.getAddress().getOffset() + ",\"call\":" + ft.isCall() + ",\"reg\":\""
					+ (reg == null ? "" : reg.getName()) + "\",\"targets\":[" + String.join(",", targets) + "]}");
				first = false;
			}
			w.println("\n],");

			w.println("\"data\": [");
			first = true;
			for (Data d : currentProgram.getListing().getDefinedData(true)) {
				w.print((first ? "" : ",\n") + "[" + d.getAddress().getOffset() + "," + (d.getAddress().getOffset() + d.getLength()) + "]");
				first = false;
			}
			w.println("\n]");
			w.println("}");
		}
		println("ExportFacts: wrote " + path);
	}
}
