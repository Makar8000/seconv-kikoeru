import { config } from "../config/index.ts";
import { logger } from "./logger.ts";

export type SeConvResult = { success: boolean; error?: string };

/**
 * Invokes the `seconv` CLI to translate all files matching `filesGlob` (a single-folder,
 * single-extension glob) from/to the configured languages, using the configured translation engine.
 */
export const translateWithSeConv = async (filesGlob: string, format: string): Promise<SeConvResult> => {
  const args: string[] = [
    filesGlob,
    "--translate-engine",
    config.translateEngine,
    "--translate-to",
    config.translateTo,
    "--overwrite",
    "--no-language-suffix",
  ];

  if (!config.seconvAdditionalArgs.includes("--format")) {
    args.push(...["--format", format]);
  }

  if (config.translateUrl.length) {
    args.push(...["--translate-url", config.translateUrl]);
  }

  if (config.translateModel.length) {
    args.push(...["--translate-model", config.translateModel]);
  }

  if (config.translateFrom.length) {
    args.push(...["--translate-from", config.translateFrom]);
  }

  if (config.seconvAdditionalArgs.length) {
    args.push(...config.seconvAdditionalArgs);
  }

  const command = new Deno.Command(config.seconvPath, {
    args,
    stdout: "inherit",
  });
  const child = command.spawn();
  const status = await child.status;

  if (!status.success) {
    const error = `seconv process exited with code ${status.code}: ${status.signal}`;
    logger.error(`Failed to translate file. ${error}`);
    return { success: false, error };
  }

  return { success: true };
};
