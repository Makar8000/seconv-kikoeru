import { statSync } from "node:fs";

/** Whether `p` is an existing regular file. */
export const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
