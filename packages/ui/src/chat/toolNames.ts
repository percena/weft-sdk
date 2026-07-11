const PARENT_TASK_TOOL_NAMES = ['Task', 'task'];
export function isParentTaskTool(toolName: string): boolean {
  return PARENT_TASK_TOOL_NAMES.includes(toolName);
}
