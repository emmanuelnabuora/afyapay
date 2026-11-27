import { Injectable } from '@nestjs/common';
import { DarajaGateway } from './daraja.gateway';
import { MpesaGateway } from './mpesa.gateway';
import { SimulatedMpesaGateway } from './simulated.gateway';

export type CollectionMode = 'simulated' | 'daraja_sandbox' | 'daraja_live';

/**
 * Picks the M-Pesa gateway for an insurer's collection account. Live Daraja is
 * refused until launch gate G4 is passed and the founder approves production.
 * Sandbox Daraja needs DARAJA_CONSUMER_KEY and DARAJA_CONSUMER_SECRET; passkeys
 * are read from environment variables named by the account's passkey_ref.
 */
@Injectable()
export class GatewayResolver {
  private daraja: DarajaGateway | null = null;

  constructor(private readonly simulated: SimulatedMpesaGateway) {}

  for(mode: CollectionMode): MpesaGateway {
    if (mode === 'simulated') return this.simulated;
    if (mode === 'daraja_live') throw new Error('Live M-Pesa is not enabled before launch gate G4');
    if (!this.daraja) {
      const consumerKey = process.env.DARAJA_CONSUMER_KEY;
      const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;
      if (!consumerKey || !consumerSecret) throw new Error('Daraja sandbox credentials are not configured');
      this.daraja = new DarajaGateway({
        baseUrl: 'https://sandbox.safaricom.co.ke',
        consumerKey,
        consumerSecret,
        passkey: (ref) => {
          const value = ref && /^[A-Z0-9_]+$/.test(ref) ? process.env[ref] : undefined;
          if (!value) throw new Error(`Passkey reference ${ref ?? '(none)'} is not configured`);
          return value;
        },
      });
    }
    return this.daraja;
  }
}
