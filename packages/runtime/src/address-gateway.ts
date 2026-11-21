import type { MapViewport } from '../../canonical-model/src/map-viewport.js';
import type { Coordinates } from '@north-star/canonical-model';
import type { RequestRuntimeView } from './request-runtime-view.js';

export interface AddressTarget {
  fieldId: string;
  recordId: string;
  companyId: string;
}
export type AddressMap =
  | { status: 'absent' | 'unavailable' | 'locating' }
  | {
      status: 'ready';
      pin: Coordinates;
      attribution: string;
      image?: string | null;
    };
export interface AddressInstallation {
  companyId: string;
  installationId: string;
  account: string;
  provider: 'google' | 'fake';
  enrichment: boolean;
}
export interface AddressSettings {
  provider: 'fake' | 'google';
  account: string;
  enrichment: boolean;
  calls: number;
  budgetMicros: number;
  enabled: boolean;
}
export interface BrowserBasemap {
  provider: 'google';
  browserKey: string;
  viewport: MapViewport;
}
export interface AddressGateway {
  issueViewport?(
    view: RequestRuntimeView,
    surfaceId: string,
    companyId: string,
    installationId: string,
    viewport: MapViewport,
  ): string;
  viewportDisplay?(
    view: RequestRuntimeView,
    handle: string,
  ): Promise<BrowserBasemap>;
  viewportImage?(
    view: RequestRuntimeView,
    handle: string,
    companyId: string,
  ): Promise<Uint8Array>;
  installations(
    view: RequestRuntimeView,
  ): Promise<readonly AddressInstallation[]>;
  canConfigure(view: RequestRuntimeView, companyId: string): Promise<boolean>;
  configure(
    view: RequestRuntimeView,
    company: string,
    options: AddressSettings,
  ): Promise<string | undefined>;
  suggest(
    view: RequestRuntimeView,
    target: AddressTarget,
    queryId: string,
    text: string,
    session: string,
  ): Promise<{
    attribution: string;
    suggestions: readonly { label: string; placeId: string }[];
  }>;
  pin(
    view: RequestRuntimeView,
    target: AddressTarget,
    queryId: string,
  ): Promise<AddressMap>;
  workOne(view: RequestRuntimeView): Promise<boolean>;
  /** Scrub expired provider coordinates in the view's environment. */
  sweep(view: RequestRuntimeView, limit?: number): Promise<number>;
}
