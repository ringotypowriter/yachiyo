import { useState } from 'react'
import { useT } from '@yachiyo/i18n/react'
import type { ProviderConfig, SettingsConfig } from '@yachiyo/shared/protocol'
import { createProviderConfig } from '@yachiyo/shared/providerConfig'
import type { ProviderPreset } from '@yachiyo/shared/providerPresets'
import { ProviderIconAvatar } from '@renderer/lib/providerIcons'
import { theme } from '@renderer/theme/theme'
import { applyOnboardingSelection, listOnboardingPresets } from './onboardingSetup'

type OnboardingStep = 'provider' | 'key' | 'model'

interface OnboardingOverlayProps {
  config: SettingsConfig
  onSkip: () => void
  onOpenProviderSettings: () => void
}

function unwrapIpcError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const ipcMatch = raw.match(/Error invoking remote method '[^']+': (.+)$/s)
  const message = (ipcMatch ? ipcMatch[1] : raw).trim()
  return message.length > 0 ? message : fallback
}

const textButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 12,
  color: 'inherit',
  padding: '4px 8px'
}

export function OnboardingOverlay({
  config,
  onSkip,
  onOpenProviderSettings
}: OnboardingOverlayProps): React.JSX.Element {
  const t = useT()
  const [step, setStep] = useState<OnboardingStep>('provider')
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [busy, setBusy] = useState<'connect' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const presets = listOnboardingPresets()

  const handlePickPreset = (next: ProviderPreset): void => {
    setPreset(next)
    setApiKey('')
    setError(null)
    setStep('key')
  }

  const handleConnect = async (): Promise<void> => {
    if (!preset || apiKey.trim().length === 0 || busy !== null) return
    setBusy('connect')
    setError(null)
    try {
      const existing = config.providers.find((provider) => provider.presetKey === preset.key)
      const probe: ProviderConfig = {
        ...(existing ??
          createProviderConfig(
            config.providers.map((provider) => provider.name),
            preset
          )),
        apiKey: apiKey.trim()
      }
      const fetched = await window.api.yachiyo.fetchProviderModels(probe)
      if (fetched.length === 0) {
        setError(t('onboarding.noModels'))
        return
      }
      setModels(fetched)
      setSelectedModel(fetched[0])
      setStep('model')
    } catch (fetchError) {
      setError(unwrapIpcError(fetchError, t('onboarding.connectFailed')))
    } finally {
      setBusy(null)
    }
  }

  const handleFinish = async (): Promise<void> => {
    if (!preset || selectedModel.length === 0 || busy !== null) return
    setBusy('save')
    setError(null)
    try {
      await window.api.yachiyo.saveConfig(
        applyOnboardingSelection(config, {
          presetKey: preset.key,
          apiKey,
          model: selectedModel
        })
      )
      // The settings.updated broadcast refreshes the store; the overlay
      // unmounts once the config has a usable provider.
    } catch (saveError) {
      setError(unwrapIpcError(saveError, t('onboarding.connectFailed')))
      setBusy(null)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(24px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
        background: theme.background.surfaceLight
      }}
    >
      <div
        style={{
          width: 460,
          maxWidth: 'calc(100vw - 48px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          padding: 28,
          borderRadius: 16,
          background: theme.background.surfaceFrosted,
          boxShadow: theme.shadow.overlay
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 17, fontWeight: 600, color: theme.text.primary }}>
            {t('onboarding.welcomeTitle')}
          </span>
          <span style={{ fontSize: 12.5, color: theme.text.muted }}>
            {t('onboarding.welcomeSubtitle')}
          </span>
        </div>

        {step === 'provider' && (
          <>
            <span style={{ fontSize: 12, fontWeight: 500, color: theme.text.secondary }}>
              {t('onboarding.pickProvider')}
            </span>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: 8,
                maxHeight: 300,
                overflowY: 'auto',
                paddingRight: 2
              }}
            >
              {presets.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => handlePickPreset(entry)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 13,
                    color: theme.text.primary,
                    background: theme.background.hover
                  }}
                >
                  <ProviderIconAvatar iconKey={entry.iconKey} size={20} />
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {entry.name}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'key' && preset && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <ProviderIconAvatar iconKey={preset.iconKey} size={24} />
              <span style={{ fontSize: 13, fontWeight: 500, color: theme.text.primary }}>
                {t('onboarding.apiKeyLabel', { provider: preset.name })}
              </span>
            </div>
            <input
              type="password"
              value={apiKey}
              autoFocus
              placeholder={t('onboarding.apiKeyPlaceholder')}
              onChange={(event) => setApiKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleConnect()
              }}
              style={{
                padding: '9px 12px',
                borderRadius: 8,
                border: `1px solid ${theme.background.hoverStrong}`,
                background: theme.background.surface,
                fontSize: 13,
                color: theme.text.primary,
                outline: 'none'
              }}
            />
            {error && <span style={{ fontSize: 12, color: theme.text.danger }}>{error}</span>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setStep('provider')
                  setError(null)
                }}
                style={{ ...textButtonStyle, color: theme.text.muted }}
              >
                {t('onboarding.back')}
              </button>
              <button
                type="button"
                onClick={() => void handleConnect()}
                disabled={apiKey.trim().length === 0 || busy !== null}
                style={{
                  padding: '8px 18px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: busy === null ? 'pointer' : 'default',
                  fontSize: 13,
                  fontWeight: 500,
                  background: theme.background.accentFill,
                  color: theme.text.onAccentFill,
                  opacity: apiKey.trim().length === 0 || busy !== null ? 0.6 : 1
                }}
              >
                {busy === 'connect' ? t('onboarding.connecting') : t('onboarding.connect')}
              </button>
            </div>
          </>
        )}

        {step === 'model' && preset && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: theme.text.secondary }}>
                {t('onboarding.pickModel')}
              </span>
              <span style={{ fontSize: 11.5, color: theme.text.muted }}>
                {t('onboarding.modelsFound', { count: models.length })}
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                maxHeight: 260,
                overflowY: 'auto',
                paddingRight: 2
              }}
            >
              {models.map((model) => {
                const selected = model === selectedModel
                return (
                  <button
                    key={model}
                    type="button"
                    onClick={() => setSelectedModel(model)}
                    style={{
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontSize: 12.5,
                      color: selected ? theme.text.onAccentFill : theme.text.primary,
                      background: selected ? theme.background.accentFill : theme.background.hover
                    }}
                  >
                    {model}
                  </button>
                )
              })}
            </div>
            {error && <span style={{ fontSize: 12, color: theme.text.danger }}>{error}</span>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setStep('key')
                  setError(null)
                }}
                style={{ ...textButtonStyle, color: theme.text.muted }}
              >
                {t('onboarding.back')}
              </button>
              <button
                type="button"
                onClick={() => void handleFinish()}
                disabled={busy !== null}
                style={{
                  padding: '8px 18px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: busy === null ? 'pointer' : 'default',
                  fontSize: 13,
                  fontWeight: 500,
                  background: theme.background.accentFill,
                  color: theme.text.onAccentFill,
                  opacity: busy !== null ? 0.6 : 1
                }}
              >
                {busy === 'save' ? t('onboarding.saving') : t('onboarding.finish')}
              </button>
            </div>
          </>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 4,
            borderTop: `1px solid ${theme.background.hover}`,
            paddingTop: 10
          }}
        >
          <button
            type="button"
            onClick={onSkip}
            style={{ ...textButtonStyle, color: theme.text.muted }}
          >
            {t('onboarding.skipForNow')}
          </button>
          <button
            type="button"
            onClick={onOpenProviderSettings}
            style={{ ...textButtonStyle, color: theme.text.muted }}
          >
            {t('onboarding.advancedSetup')}
          </button>
        </div>
      </div>
    </div>
  )
}
