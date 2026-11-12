/**
 * Splits a line typed by the user into program arguments.
 *
 * Whitespace separates arguments. Double quotes group text that contains spaces, and a backslash before a double
 * quote keeps the quote as a literal character. Other backslashes are kept, so Windows paths can be typed as is.
 */
export function splitArguments(argumentLine: string): string[] {
  const splitResult: string[] = [];
  let currentArgument = '';
  let isInsideQuotes = false;
  let hasArgument = false;

  for (let charIndex = 0; charIndex < argumentLine.length; charIndex++) {
    const character = argumentLine[charIndex];
    if (character === '\\' && argumentLine[charIndex + 1] === '"') {
      currentArgument += '"';
      hasArgument = true;
      charIndex++;
      continue;
    }

    if (character === '"') {
      isInsideQuotes = !isInsideQuotes;
      // "" is an empty argument, so a pair of quotes alone still produces one.
      hasArgument = true;
      continue;
    }

    if (!isInsideQuotes && /\s/.test(character)) {
      if (hasArgument) {
        splitResult.push(currentArgument);
        currentArgument = '';
        hasArgument = false;
      }
      continue;
    }

    currentArgument += character;
    hasArgument = true;
  }

  if (hasArgument) {
    splitResult.push(currentArgument);
  }
  return splitResult;
}
