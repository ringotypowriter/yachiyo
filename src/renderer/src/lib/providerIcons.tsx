/**
 * Lightweight provider icon lookup.
 *
 * Instead of using the generic `ProviderIcon` from @lobehub/icons (which pulls
 * in every provider icon via providerConfig.js), we import only the icons we
 * actually use and build a small mapping. This keeps the bundle lean.
 *
 * Uses `.Color` (multi-color) where available, falls back to the default Mono.
 */
import type { FC } from 'react'
import Anthropic from '@lobehub/icons/es/Anthropic'
import Bailian from '@lobehub/icons/es/Bailian'
import DeepSeek from '@lobehub/icons/es/DeepSeek'
import Google from '@lobehub/icons/es/Google'
import Kimi from '@lobehub/icons/es/Kimi'
import Minimax from '@lobehub/icons/es/Minimax'
import Mistral from '@lobehub/icons/es/Mistral'
import Moonshot from '@lobehub/icons/es/Moonshot'
import Ollama from '@lobehub/icons/es/Ollama'
import OpenAI from '@lobehub/icons/es/OpenAI'
import OpenRouter from '@lobehub/icons/es/OpenRouter'
import Vercel from '@lobehub/icons/es/Vercel'
import VertexAI from '@lobehub/icons/es/VertexAI'
import ZAI from '@lobehub/icons/es/ZAI'
import Zhipu from '@lobehub/icons/es/Zhipu'
import packycodeSvg from '@renderer/assets/icons/packycode.svg'

type IconFC = FC<{ size?: number }>

/** Color variant when available, Mono otherwise */
const iconMap: Record<string, IconFC> = {
  anthropic: Anthropic,
  bailian: Bailian.Color,
  deepseek: DeepSeek.Color,
  google: Google.Color,
  kimicodingplan: Kimi,
  minimax: Minimax.Color,
  mistral: Mistral.Color,
  moonshot: Moonshot,
  ollama: Ollama,
  openai: OpenAI,
  openrouter: OpenRouter,
  vercel: Vercel,
  vertexai: VertexAI.Color,
  zai: ZAI,
  zhipu: Zhipu.Color
}

/** Icon keys that use a bundled SVG asset instead of @lobehub/icons */
const svgIconMap: Record<string, string> = {
  packycode: packycodeSvg
}

export function ProviderIconAvatar({
  iconKey,
  size
}: {
  iconKey: string
  size: number
}): React.ReactNode {
  const svgSrc = svgIconMap[iconKey]
  if (svgSrc) {
    return (
      <img
        src={svgSrc}
        alt={iconKey}
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: 'contain' }}
      />
    )
  }

  const Icon = iconMap[iconKey]
  if (!Icon) return null
  return <Icon size={size} />
}
