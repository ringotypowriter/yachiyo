import {
  AppWindow,
  BookOpenCheck,
  Boxes,
  Brain,
  ClipboardPenLine,
  ContactRound,
  DatabaseZap,
  Diff,
  DoorOpen,
  Eye,
  FilePlus2,
  FolderSearch2,
  ListChecks,
  MessageCircleQuestion,
  MessagesSquare,
  Network,
  Newspaper,
  PenLine,
  Radar,
  SendHorizontal,
  SquareTerminal,
  Telescope,
  TextSearch,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import JavascriptIcon from '@icons-pack/react-simple-icons/icons/SiJavascript'
import PythonIcon from '@icons-pack/react-simple-icons/icons/SiPython'
import type { ToolCallName } from '@yachiyo/shared/protocol'

export type ToolCallIcon = LucideIcon | typeof JavascriptIcon

const coreToolIcons = {
  read: Eye,
  write: FilePlus2,
  edit: PenLine,
  bash: SquareTerminal,
  jsRepl: JavascriptIcon,
  pyRepl: PythonIcon,
  grep: TextSearch,
  glob: FolderSearch2,
  webRead: Newspaper,
  useBrowser: AppWindow,
  webSearch: Telescope,
  skillsRead: BookOpenCheck,
  applyPatch: Diff,
  useSentinel: Radar,
  askUser: MessageCircleQuestion,
  delegateTask: Network,
  remember: Brain,
  querySource: DatabaseZap,
  useThings: Boxes,
  reviewThings: ClipboardPenLine,
  updateProfile: ContactRound,
  updateTodoList: ListChecks,
  sendThreadMessage: MessagesSquare,
  sendMessage: SendHorizontal,
  exitPlanMode: DoorOpen
} satisfies Record<ToolCallName, ToolCallIcon>

export function getToolCallIcon(toolName: string): ToolCallIcon {
  return Object.prototype.hasOwnProperty.call(coreToolIcons, toolName)
    ? coreToolIcons[toolName as ToolCallName]
    : Wrench
}
