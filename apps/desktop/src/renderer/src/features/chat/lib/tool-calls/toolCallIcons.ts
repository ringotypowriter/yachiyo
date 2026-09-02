import {
  BookOpenCheck,
  Brain,
  Braces,
  ClipboardCheck,
  DatabaseSearch,
  FileDiff,
  FilePenLine,
  FilePlus2,
  Files,
  FileText,
  Globe2,
  ListTodo,
  LogOut,
  MessageCircleQuestion,
  MessagesSquare,
  PackageSearch,
  PanelsTopLeft,
  Search,
  Send,
  ShieldCheck,
  Terminal,
  TextSearch,
  UserRoundCog,
  Workflow,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { ToolCallName } from '@yachiyo/shared/protocol'

const coreToolIcons = {
  read: FileText,
  write: FilePlus2,
  edit: FilePenLine,
  bash: Terminal,
  jsRepl: Braces,
  pyRepl: Terminal,
  grep: TextSearch,
  glob: Files,
  webRead: Globe2,
  useBrowser: PanelsTopLeft,
  webSearch: Search,
  skillsRead: BookOpenCheck,
  applyPatch: FileDiff,
  useSentinel: ShieldCheck,
  askUser: MessageCircleQuestion,
  delegateTask: Workflow,
  remember: Brain,
  querySource: DatabaseSearch,
  useThings: PackageSearch,
  reviewThings: ClipboardCheck,
  updateProfile: UserRoundCog,
  updateTodoList: ListTodo,
  sendThreadMessage: MessagesSquare,
  sendMessage: Send,
  exitPlanMode: LogOut
} satisfies Record<ToolCallName, LucideIcon>

export function getToolCallIcon(toolName: string): LucideIcon {
  return Object.prototype.hasOwnProperty.call(coreToolIcons, toolName)
    ? coreToolIcons[toolName as ToolCallName]
    : Wrench
}
