import { buildFile } from "./buildNode";
import { cpSync as cp } from "node:fs";

buildFile("./image.ts")
buildFile("./player.ts")
buildFile("./matrix.ts")
buildFile("./util.ts")
buildFile("./respack.ts")


cp("./constants.ts", "./render/constants.ts", { force: true });
cp("./respack-phira.ts", "./render/respack-phira.ts", { force: true });