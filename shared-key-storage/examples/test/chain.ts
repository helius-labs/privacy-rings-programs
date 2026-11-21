/**
 * The SDK's LiteSVM test chain with the Swig binary dumped from mainnet
 * (`test/fixtures/swig.so`) added.
 */
import { fileURLToPath } from "node:url";

import { Chain as RecordChain } from "../../sdk/test/chain.js";
import { SWIG_PROGRAM_ADDRESS } from "../helpers/swig/program.js";

export { recordBytes } from "../../sdk/test/chain.js";

const SWIG_SO = fileURLToPath(new URL("./fixtures/swig.so", import.meta.url));

/** A LiteSVM with the mainnet Record and Swig binaries. */
export class Chain extends RecordChain {
  constructor() {
    super();
    this.svm.addProgramFromFile(SWIG_PROGRAM_ADDRESS, SWIG_SO);
  }
}
