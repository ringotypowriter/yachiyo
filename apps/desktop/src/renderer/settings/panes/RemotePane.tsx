import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Smartphone } from 'lucide-react'
import type { RemoteTunnelMode, SettingsConfig } from '@yachiyo/shared/protocol'
import type { RemotePairingInfo, RemoteStatusResult } from '@yachiyo/shared/remote/command'
import { useT } from '@yachiyo/i18n/react'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { alpha, theme } from '@renderer/theme/theme'
import {
  SettingItem,
  SettingLabel,
  SettingSection,
  SettingSwitch,
  SimpleSelect
} from '../components/primitives'
import { inputStyle } from '../components/styles'
import { remoteAddressLabel, remoteConfigOf, remoteStatusHint, withRemote } from './remotePaneModel'

const STATUS_POLL_MS = 5_000

interface RemotePaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

interface PairingQr {
  url: string
  expiresAt: string
  svg: string
}

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    minHeight: 30,
    border: `1px solid ${theme.border.subtle}`,
    borderRadius: 999,
    padding: '4px 12px',
    fontSize: 13,
    fontWeight: 600,
    background: disabled ? alpha('ink', 0.03) : theme.background.surface,
    color: disabled ? theme.text.muted : theme.text.secondary,
    opacity: disabled ? 0.55 : 1
  }
}

function CopyButton({ value, label }: { value: string; label: string }): React.ReactNode {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button type="button" style={buttonStyle(false)} onClick={copy}>
      {copied ? t('common.copied') : label}
    </button>
  )
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function PairingOverlay({ qr, onClose }: { qr: PairingQr; onClose: () => void }): React.ReactNode {
  const t = useT()
  useEffect(() => {
    const delay = new Date(qr.expiresAt).getTime() - Date.now()
    const timer = setTimeout(onClose, Math.max(0, delay))
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
    }
  }, [qr.expiresAt, onClose])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.remote.qrTitle')}
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: alpha('ink', 0.32), zIndex: 1000 }}
      onClick={onClose}
    >
      <div
        className="flex flex-col items-center gap-4 rounded-2xl px-8 py-7"
        style={{ background: theme.background.surface, boxShadow: theme.shadow.panel }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
          {t('settings.remote.qrTitle')}
        </div>
        <img
          alt=""
          width={232}
          height={232}
          style={{ background: '#ffffff', borderRadius: 12, padding: 8 }}
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`}
        />
        <div className="text-xs" style={{ color: theme.text.tertiary }}>
          {t('settings.remote.qrExpires', { time: formatTime(qr.expiresAt) })}
        </div>
        <div className="flex gap-2">
          <CopyButton value={qr.url} label={t('settings.remote.qrCopyLink')} />
          <button type="button" style={buttonStyle(false)} onClick={onClose}>
            {t('settings.remote.qrClose')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export function RemotePane({ draft, onChange }: RemotePaneProps): React.ReactNode {
  const t = useT()
  const dialog = useAppDialog()
  const remote = remoteConfigOf(draft)
  const [status, setStatus] = useState<RemoteStatusResult | null>(null)
  const [pairings, setPairings] = useState<RemotePairingInfo[]>([])
  const [qr, setQr] = useState<PairingQr | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback((): Promise<void> => {
    return Promise.all([
      window.api.yachiyo.getRemoteStatus(),
      window.api.yachiyo.listRemotePairings()
    ]).then(
      ([nextStatus, nextPairings]) => {
        setStatus(nextStatus)
        setPairings(nextPairings)
        setError(null)
      },
      () => setError(t('settings.remote.loadFailed'))
    )
  }, [t])

  useEffect(() => {
    const tick = (): void => void reload()
    const timer = setInterval(tick, STATUS_POLL_MS)
    const first = setTimeout(tick, 0)
    return () => {
      clearInterval(timer)
      clearTimeout(first)
    }
  }, [reload])

  const showPairing = async (): Promise<void> => {
    try {
      setQr(await window.api.yachiyo.createRemotePairing())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const closePairing = useCallback((): void => {
    setQr(null)
    void reload()
  }, [reload])

  const revoke = async (pairing: RemotePairingInfo): Promise<void> => {
    const confirmed = await dialog.confirm({
      title: t('settings.remote.revokeConfirmTitle', { name: pairing.deviceName }),
      message: t('settings.remote.revokeConfirmBody'),
      confirmLabel: t('settings.remote.revoke'),
      cancelLabel: t('common.cancel'),
      tone: 'danger'
    })
    if (!confirmed) return
    await window.api.yachiyo.revokeRemotePairing(pairing.pairingId)
    await reload()
  }

  const tunnelOptions: Array<{ value: RemoteTunnelMode; label: string }> = [
    { value: 'quick', label: t('settings.remote.tunnelQuick') },
    { value: 'named', label: t('settings.remote.tunnelNamed') },
    { value: 'none', label: t('settings.remote.tunnelNone') }
  ]
  const address = remoteAddressLabel(status)
  const hint = remoteStatusHint(status)
  const canPair = Boolean(status?.running && status.endpoints.length > 0)

  return (
    <div className="flex-1 overflow-y-auto pb-8">
      <SettingSection>
        <SettingLabel>{t('settings.remote.title')}</SettingLabel>
        <SettingItem
          label={t('settings.remote.enable')}
          description={t('settings.remote.enableDescription')}
          control={
            <SettingSwitch
              checked={remote.enabled}
              ariaLabel={t('settings.remote.enable')}
              onChange={() => onChange(withRemote(draft, { enabled: !remote.enabled }))}
            />
          }
        />
        <SettingItem
          label={t('settings.remote.tunnel')}
          description={t('settings.remote.tunnelDescription')}
          control={
            <SimpleSelect
              value={remote.tunnel}
              options={tunnelOptions}
              onChange={(tunnel) => onChange(withRemote(draft, { tunnel }))}
            />
          }
        />
        {remote.tunnel === 'named' ? (
          <SettingItem
            label={t('settings.remote.namedHostname')}
            description={t('settings.remote.namedHostnameDescription')}
            control={
              <input
                value={remote.namedHostname}
                placeholder="yachiyo.example.com"
                spellCheck={false}
                className="h-8 w-56 rounded-lg px-3 text-sm outline-none"
                style={inputStyle()}
                onChange={(event) =>
                  onChange(withRemote(draft, { namedHostname: event.target.value.trim() }))
                }
              />
            }
          />
        ) : null}
        <SettingItem
          label={t('settings.remote.lanEndpoint')}
          description={t('settings.remote.lanEndpointDescription')}
          control={
            <SettingSwitch
              checked={remote.lanEndpoint}
              ariaLabel={t('settings.remote.lanEndpoint')}
              onChange={() => onChange(withRemote(draft, { lanEndpoint: !remote.lanEndpoint }))}
            />
          }
        />
        <SettingItem
          label={t('settings.remote.keepAwake')}
          description={t('settings.remote.keepAwakeDescription')}
          control={
            <SettingSwitch
              checked={remote.keepAwakeOnPower}
              ariaLabel={t('settings.remote.keepAwake')}
              onChange={() =>
                onChange(withRemote(draft, { keepAwakeOnPower: !remote.keepAwakeOnPower }))
              }
            />
          }
        />
        <SettingItem
          label={t('settings.remote.address')}
          description={
            status?.running
              ? (address ?? t('settings.remote.addressNone'))
              : t('settings.remote.notRunning')
          }
          hint={
            error ??
            (hint === 'cloudflared-stopped'
              ? t('settings.remote.cloudflaredStopped')
              : hint === 'icloud-unavailable'
                ? t('settings.remote.icloudUnavailable')
                : undefined)
          }
          control={
            status?.running && address ? (
              <CopyButton value={address} label={t('common.copy')} />
            ) : undefined
          }
        />
        <SettingItem
          label={t('settings.remote.pair')}
          description={
            canPair ? t('settings.remote.pairDescription') : t('settings.remote.pairUnavailable')
          }
          control={
            <button
              type="button"
              disabled={!canPair}
              style={buttonStyle(!canPair)}
              onClick={() => void showPairing()}
            >
              {t('settings.remote.pairButton')}
            </button>
          }
        />
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.remote.phones')}</SettingLabel>
        {pairings.length === 0 ? (
          <SettingItem label={t('settings.remote.phonesEmpty')} />
        ) : (
          pairings.map((pairing) => (
            <SettingItem
              key={pairing.pairingId}
              label={
                <span className="inline-flex items-center gap-2">
                  <Smartphone size={14} strokeWidth={1.8} aria-hidden="true" />
                  {pairing.deviceName}
                </span>
              }
              description={
                pairing.lastSeenAt
                  ? t('settings.remote.lastSeen', {
                      time: new Date(pairing.lastSeenAt).toLocaleString()
                    })
                  : t('settings.remote.neverSeen')
              }
              control={
                <button
                  type="button"
                  style={buttonStyle(false)}
                  onClick={() => void revoke(pairing)}
                >
                  {t('settings.remote.revoke')}
                </button>
              }
            />
          ))
        )}
      </SettingSection>

      {qr ? <PairingOverlay qr={qr} onClose={closePairing} /> : null}
    </div>
  )
}
