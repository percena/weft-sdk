/**
 * Safe gray-matter Wrapper
 *
 * gray-matter ships a JavaScript engine that `eval()`s frontmatter when a
 * document declares a code language (e.g. `---js`). Skill files are untrusted
 * input, so all code-executing engines are replaced with throwing stubs.
 * YAML (and JSON) frontmatter behavior is unchanged.
 */

import matter from 'gray-matter';

const disabledEngine = {
  parse: (): never => {
    throw new Error('frontmatter engine disabled');
  },
  stringify: (): never => {
    throw new Error('frontmatter engine disabled');
  },
};

/**
 * Covers every alias gray-matter maps to a code engine:
 * js/javascript → javascript, coffee/coffeescript/cson → coffee.
 */
const SAFE_ENGINES = {
  js: disabledEngine,
  javascript: disabledEngine,
  coffee: disabledEngine,
  coffeescript: disabledEngine,
  cson: disabledEngine,
};

/**
 * Parse frontmatter with code engines disabled.
 * Drop-in replacement for `matter(content)` — use this for all untrusted input.
 */
export function safeMatter(content: string): matter.GrayMatterFile<string> {
  return matter(content, { engines: SAFE_ENGINES });
}
