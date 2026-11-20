import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import {
  AddressInputSchema,
  CoordinatesSchema,
  type Coordinates,
} from '@north-star/canonical-model';
import { z } from 'zod';

const place = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);
const suggestion = z.strictObject({
  label: z.string().trim().min(1).max(512),
  placeId: place,
});
export type Suggestion = z.infer<typeof suggestion>;
const result = CoordinatesSchema.extend({
  precision: z.enum(['rooftop', 'interpolated', 'approximate', 'center']),
});
export type Geocode = z.infer<typeof result>;
export type ProviderFailure =
  'unconfigured' | 'quota' | 'unavailable' | 'noMatch' | 'invalidResult';
export class AddressProviderError extends Error {
  constructor(readonly reason: ProviderFailure) {
    super(reason);
  }
}
export const ADDRESS_CONTRACT = Object.freeze({
  schemaVersion: 'northstar.connector/v1',
  id: 'address',
  version: 'northstar.address/v1',
  operations: {
    suggest: {
      id: 'address.suggest',
      version: 1,
      kind: 'interactiveRead',
      deadlineMs: 2500,
      attempts: 1,
      maxResults: 5,
      quotaUnits: 1,
    },
    geocode: {
      id: 'address.geocode',
      version: 1,
      kind: 'queuedRead',
      deadlineMs: 4000,
      attempts: 4,
      retryAfterSeconds: [5, 30, 120],
      quotaUnits: 1,
    },
    staticMap: {
      id: 'address.staticMap',
      version: 1,
      kind: 'read',
      deadlineMs: 500,
      attempts: 1,
      quotaUnits: 0,
    },
  },
  inbound: [],
  health: { kind: 'read', deadlineMs: 2500, minimumIntervalSeconds: 300 },
} as const);
export interface AddressProvider {
  readonly name: 'fake' | 'google';
  readonly attribution: string;
  suggest(text: string, session: string): Promise<readonly Suggestion[]>;
  geocode(text: string, placeId?: string): Promise<Geocode>;
  staticMap(pin: Coordinates): string | null;
}
export interface InstallationIdentity {
  tenantId: string;
  environmentId: string;
  companyId: string;
  installationId: string;
  account: string;
}

export class FakeAddressProvider implements AddressProvider {
  readonly name = 'fake';
  readonly attribution = 'Demo Maps';
  constructor(
    private readonly behavior?: (
      operation: 'suggest' | 'geocode',
      text: string,
    ) => Promise<void>,
  ) {}
  async suggest(text: string) {
    await this.behavior?.('suggest', text);
    return [
      {
        label: text + ' · Demo Maps',
        placeId: createHash('sha256').update(text).digest('hex'),
      },
    ];
  }
  async geocode(text: string): Promise<Geocode> {
    await this.behavior?.('geocode', text);
    const digest = createHash('sha256').update(text).digest();
    return {
      latitude: ((digest.readUInt32BE(0) % 16000000) / 100000 - 80).toFixed(5),
      longitude: ((digest.readUInt32BE(4) % 34000000) / 100000 - 170).toFixed(
        5,
      ),
      precision: 'rooftop',
    };
  }
  staticMap(pin: Coordinates) {
    const { latitude, longitude } = CoordinatesSchema.parse(pin);
    const x = (((Number(longitude) + 180) / 360) * 240).toFixed(2);
    const y = (((90 - Number(latitude)) / 180) * 120).toFixed(2);
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" role="img"><title>Demo Maps pin at ' +
      latitude +
      ', ' +
      longitude +
      '</title><rect width="240" height="120" fill="#dbe8e3"/><path d="M0 60h240M120 0v120" stroke="#8ba89a"/><circle cx="' +
      x +
      '" cy="' +
      y +
      '" r="5" fill="#173835"/><text x="5" y="114" font-size="10">Demo Maps</text></svg>'
    );
  }
}

async function credential(scope: InstallationIdentity): Promise<string> {
  const file = process.env.NORTH_STAR_CONNECTOR_KEY_FILE;
  if (!file || !isAbsolute(file))
    throw new AddressProviderError('unconfigured');
  try {
    const location = await realpath(file);
    const fromCheckout = relative(process.cwd(), location);
    if (fromCheckout !== '..' && !fromCheckout.startsWith('..' + sep))
      throw new Error();
    const handle = await open(location, 'r');
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.mode & 0o077 ||
        stat.size > 65536 ||
        stat.uid !== process.getuid?.()
      )
        throw new Error();
      const entries: unknown = JSON.parse(await handle.readFile('utf8'));
      const match = z
        .array(
          z.object({
            tenantId: z.uuid(),
            environmentId: z.uuid(),
            companyId: z.uuid(),
            installationId: z.uuid(),
            account: z.string(),
            purpose: z.literal('maps'),
            key: z.string().min(1).max(512),
          }),
        )
        .max(128)
        .parse(entries)
        .filter(
          (e) =>
            e.tenantId === scope.tenantId &&
            e.environmentId === scope.environmentId &&
            e.companyId === scope.companyId &&
            e.installationId === scope.installationId &&
            e.account === scope.account,
        );
      if (match.length !== 1) throw new Error();
      return match[0]!.key;
    } finally {
      await handle.close();
    }
  } catch {
    throw new AddressProviderError('unconfigured');
  }
}
async function json(url: URL, init: RequestInit, deadline: number) {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(deadline),
    });
    if (!response.ok || !response.body)
      throw new AddressProviderError(
        response.status === 429
          ? 'quota'
          : response.status === 403
            ? 'unconfigured'
            : 'unavailable',
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 32768) {
        await reader.cancel();
        throw new AddressProviderError('invalidResult');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (e) {
    throw e instanceof AddressProviderError
      ? e
      : new AddressProviderError('unavailable');
  }
}
class GoogleAddressProvider implements AddressProvider {
  readonly name = 'google';
  readonly attribution = 'Google Maps';
  constructor(private readonly scope: InstallationIdentity) {}
  async suggest(input: string, sessionToken: string) {
    AddressInputSchema.shape.text.parse(input);
    const response = await json(
      new URL('https://places.googleapis.com/v1/places:autocomplete'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': await credential(this.scope),
          'X-Goog-FieldMask':
            'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text',
        },
        body: JSON.stringify({
          input,
          sessionToken,
          includeQueryPredictions: false,
        }),
      },
      ADDRESS_CONTRACT.operations.suggest.deadlineMs,
    );
    const parsed = z
      .object({
        suggestions: z
          .array(
            z.object({
              placePrediction: z.object({
                placeId: place,
                text: z.object({ text: suggestion.shape.label }),
              }),
            }),
          )
          .max(5)
          .optional(),
      })
      .safeParse(response);
    if (!parsed.success) throw new AddressProviderError('invalidResult');
    return (parsed.data.suggestions ?? []).map(({ placePrediction: p }) => ({
      label: p.text.text,
      placeId: p.placeId,
    }));
  }
  async geocode(input: string, placeId?: string) {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    if (placeId) url.searchParams.set('place_id', place.parse(placeId));
    else
      url.searchParams.set(
        'address',
        AddressInputSchema.shape.text.parse(input),
      );
    url.searchParams.set('key', await credential(this.scope));
    const response = await json(
      url,
      { method: 'GET' },
      ADDRESS_CONTRACT.operations.geocode.deadlineMs,
    );
    const parsed = z
      .object({
        status: z.string(),
        results: z.array(
          z.object({
            geometry: z.object({
              location: z.object({
                lat: z.number().min(-90).max(90),
                lng: z.number().min(-180).max(180),
              }),
              location_type: z.enum([
                'ROOFTOP',
                'RANGE_INTERPOLATED',
                'APPROXIMATE',
                'GEOMETRIC_CENTER',
              ]),
            }),
          }),
        ),
      })
      .safeParse(response);
    if (!parsed.success) throw new AddressProviderError('invalidResult');
    const first = parsed.data.results[0];
    if (parsed.data.status !== 'OK' || !first)
      throw new AddressProviderError(
        parsed.data.status === 'ZERO_RESULTS'
          ? 'noMatch'
          : parsed.data.status === 'OVER_QUERY_LIMIT'
            ? 'quota'
            : parsed.data.status === 'REQUEST_DENIED'
              ? 'unconfigured'
              : 'unavailable',
      );
    return result.parse({
      latitude: first.geometry.location.lat.toFixed(7),
      longitude: first.geometry.location.lng.toFixed(7),
      precision: {
        ROOFTOP: 'rooftop',
        RANGE_INTERPOLATED: 'interpolated',
        APPROXIMATE: 'approximate',
        GEOMETRIC_CENTER: 'center',
      }[first.geometry.location_type],
    });
  }
  staticMap() {
    return null;
  }
}
export function addressProvider(
  scope: InstallationIdentity,
  provider: 'fake' | 'google',
  localDemo: boolean,
  supportedRegion: boolean,
): AddressProvider {
  if (process.env.CI || provider === 'fake') return new FakeAddressProvider();
  if (
    !localDemo ||
    !supportedRegion ||
    process.env.NORTH_STAR_CONNECTOR_DEMO !== '1'
  )
    throw new AddressProviderError('unconfigured');
  return new GoogleAddressProvider(scope);
}
