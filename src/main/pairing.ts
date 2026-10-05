import os from 'os'
import { api, ApiError, NetworkError, type PairingStart } from './api'
import type { DeviceInfo, PairingInfo } from '../shared/types'
import { PRODUCT_NAME } from './config'

/*
 * Appairage du poste (Device Authorization Grant) : Mapli remet un code « MAPL-XXXX »,
 * l'utilisateur l'approuve sur app.mapli.fr, et le poste reçoit un token d'appareil
 * (révocable dans Réglages → Sécurité → Appareils connectés). Aucun mot de passe ne
 * transite ni n'est gardé par le poste.
 */

export interface PairingResult extends DeviceInfo {
  token: string
}

interface Callbacks {
  onUpdate: (pairing: PairingInfo) => void
  onApproved: (result: PairingResult) => void
  onError: (message: string) => void
}

export class PairingFlow {
  private timer: NodeJS.Timeout | null = null
  private active: PairingStart | null = null
  private info: PairingInfo | null = null
  private cancelled = false

  constructor(private readonly callbacks: Callbacks) {}

  /** Nom du poste vu dans « Appareils connectés » (ex. « Mapli Drive — PC-JULIE »). */
  static deviceName(): string {
    return `${PRODUCT_NAME} — ${os.hostname()}`.slice(0, 120)
  }

  async start(): Promise<PairingInfo> {
    this.stop()
    this.cancelled = false

    const started = await api.startPairing(
      PairingFlow.deviceName(),
      process.platform === 'darwin' ? 'macos' : 'windows'
    )
    this.active = started
    this.info = {
      code: started.device_code,
      url: started.verification_url_complete,
      expiresAt: Date.now() + started.expires_in * 1000,
      status: 'waiting'
    }
    this.schedule()

    return this.info
  }

  cancel(): void {
    this.cancelled = true
    this.stop()
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.active = null
  }

  private schedule(): void {
    const interval = Math.max(2, this.active?.poll_interval ?? 3) * 1000
    this.timer = setTimeout(() => void this.poll(), interval)
  }

  private async poll(): Promise<void> {
    const active = this.active
    if (!active || !this.info || this.cancelled) return

    if (Date.now() > this.info.expiresAt) {
      this.finish({ ...this.info, status: 'expired' })
      return
    }

    try {
      const result = await api.pollPairing(active.device_code, active.device_secret)
      if (this.cancelled || this.active !== active) return

      if (result.status === 'approved') {
        this.stop()
        this.callbacks.onApproved({
          token: result.token,
          user: result.user,
          organization: result.organization ?? { id: '', name: 'Mapli' }
        })
        return
      }

      if (
        result.status === 'denied' ||
        result.status === 'expired' ||
        result.status === 'claimed'
      ) {
        this.finish({ ...this.info, status: result.status === 'denied' ? 'denied' : 'expired' })
        return
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        this.finish({ ...this.info, status: 'expired' })
        return
      }
      if (!(error instanceof NetworkError)) {
        this.callbacks.onError(error instanceof Error ? error.message : 'Appairage impossible.')
      }
      // Réseau momentanément coupé : on réessaie au prochain tour.
    }

    this.schedule()
  }

  private finish(info: PairingInfo): void {
    this.stop()
    this.info = info
    this.callbacks.onUpdate(info)
  }
}
