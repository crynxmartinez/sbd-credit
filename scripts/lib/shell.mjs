/**
 * Turns an argument list back into one command line for a shell, keeping any argument that contains spaces or other
 * special characters in one piece. Joining with a plain space (the earlier approach) silently turned
 * `create admin "E2E Admin" ROLE` into four arguments.
 */
const SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

export function quoteArg(argument) {
  if (argument !== "" && SAFE_ARGUMENT.test(argument)) return argument;
  return `"${argument.replace(/(["\\])/g, "\\$1")}"`;
}

export const joinCommand = (args) => args.map(quoteArg).join(" ");
