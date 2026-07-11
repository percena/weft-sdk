/**
 * Type declarations for bash-parser
 *
 * bash-parser provides POSIX shell script parsing into an AST.
 * Used by read-patterns.ts to detect file-reading shell commands.
 */

declare module 'bash-parser' {
  interface ASTNode {
    type: string;
  }

  interface WordNode extends ASTNode {
    type: 'Word';
    text: string;
  }

  interface CommandNode extends ASTNode {
    type: 'Command';
    name?: WordNode;
    suffix?: ASTNode[];
  }

  interface ScriptNode extends ASTNode {
    type: 'Script';
    commands: ASTNode[];
  }

  interface ParseResult {
    type: 'Script';
    commands: ASTNode[];
  }

  function parse(input: string): ParseResult | { type: string; errors: unknown[] };

  export default parse;
}