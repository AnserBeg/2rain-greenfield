import {
  STATUS_ROLES,
  SURFACE_ARCHETYPES,
  SURFACE_SLOTS,
} from '@north-star/canonical-model';

type SurfaceArchetype = (typeof SURFACE_ARCHETYPES)[number];

export const SURFACE_GRAMMAR_LIMITS = Object.freeze({
  compactNavigationItems: 5,
  desktopNavigationItems: 7,
  minimumContrastRatio: 4.5,
  minimumTargetPixels: 44,
});

export type SurfaceGrammarRuleId =
  | 'SG001_NO_SURFACES'
  | 'SG002_ARCHETYPE_COVERAGE'
  | 'SG003_REQUIRED_SLOT'
  | 'SG004_DUPLICATE_SLOT'
  | 'SG005_FOCUS_ORDER'
  | 'SG006_STATUS_ROLE'
  | 'SG007_DESKTOP_NAVIGATION_BUDGET'
  | 'SG008_COMPACT_NAVIGATION_BUDGET'
  | 'SG009_COMPACT_SLOT'
  | 'SG010_CONTRAST'
  | 'SG011_TARGET_SIZE';

export interface SurfaceGrammarViolation {
  readonly message: string;
  readonly ruleId: SurfaceGrammarRuleId;
  readonly subjectId: string;
}

export interface ConformanceSurface {
  readonly archetype: string;
  readonly lifecycle: string;
  readonly slots: readonly {
    readonly orderKey: number;
    readonly slot: string;
    readonly slotId: string;
  }[];
  readonly statusRoles: readonly string[];
  readonly surfaceId: string;
}

export interface CompactSurfaceProjection {
  readonly navigationSurfaceIds: readonly string[];
  readonly surfaces: readonly {
    readonly slots: readonly string[];
    readonly surfaceId: string;
  }[];
}

export interface SurfaceGrammarCheckResult {
  readonly compactSurfacesRead: number;
  readonly surfacesRead: number;
  readonly violations: readonly SurfaceGrammarViolation[];
}

export interface ContrastPair {
  readonly background: string;
  readonly foreground: string;
  readonly subjectId: string;
}

export interface TargetMeasurement {
  readonly height: number;
  readonly subjectId: string;
  readonly width: number;
}

export interface AccessibilityCheckResult {
  readonly contrastPairsRead: number;
  readonly targetsRead: number;
  readonly violations: readonly SurfaceGrammarViolation[];
}

export function projectCompactSurfaces(
  surfaces: readonly ConformanceSurface[],
): CompactSurfaceProjection {
  const active = surfaces.filter((surface) => surface.lifecycle === 'active');
  return Object.freeze({
    navigationSurfaceIds: Object.freeze(
      active.map((surface) => surface.surfaceId),
    ),
    surfaces: Object.freeze(
      active.map((surface) =>
        Object.freeze({
          slots: Object.freeze(surface.slots.map((slot) => slot.slot)),
          surfaceId: surface.surfaceId,
        }),
      ),
    ),
  });
}

export function checkSurfaceGrammarConformance(
  surfaces: readonly ConformanceSurface[],
  compact = projectCompactSurfaces(surfaces),
): SurfaceGrammarCheckResult {
  const active = surfaces.filter((surface) => surface.lifecycle === 'active');
  const violations: SurfaceGrammarViolation[] = [];
  if (active.length === 0) {
    add(
      violations,
      'SG001_NO_SURFACES',
      'package',
      'surface grammar read zero active surfaces',
    );
  }

  const observedArchetypes = new Set(
    active.map((surface) => surface.archetype),
  );
  for (const archetype of SURFACE_ARCHETYPES) {
    if (!observedArchetypes.has(archetype)) {
      add(
        violations,
        'SG002_ARCHETYPE_COVERAGE',
        archetype,
        `no active ${archetype} surface was observed`,
      );
    }
  }

  for (const surface of active) {
    if (!isArchetype(surface.archetype)) {
      add(
        violations,
        'SG002_ARCHETYPE_COVERAGE',
        surface.surfaceId,
        `unknown archetype ${surface.archetype}`,
      );
      continue;
    }
    const seen = new Set<string>();
    const expectedSlots = SURFACE_SLOTS[surface.archetype];
    for (const requiredSlot of expectedSlots) {
      if (!surface.slots.some((slot) => slot.slot === requiredSlot)) {
        add(
          violations,
          'SG003_REQUIRED_SLOT',
          surface.surfaceId,
          `required slot ${requiredSlot} was not observed`,
        );
      }
    }
    let previousOrderKey = -1;
    for (const slot of surface.slots) {
      if (seen.has(slot.slot)) {
        add(
          violations,
          'SG004_DUPLICATE_SLOT',
          surface.surfaceId,
          `slot ${slot.slot} was observed more than once`,
        );
      }
      seen.add(slot.slot);
      if (slot.orderKey <= previousOrderKey) {
        add(
          violations,
          'SG005_FOCUS_ORDER',
          surface.surfaceId,
          'slot order keys must be strictly increasing in rendered focus order',
        );
      }
      previousOrderKey = slot.orderKey;
    }
    for (const role of surface.statusRoles) {
      if (!STATUS_ROLES.some((candidate) => candidate === role)) {
        add(
          violations,
          'SG006_STATUS_ROLE',
          surface.surfaceId,
          `status ${role} is not a closed role token`,
        );
      }
    }

    const compactSurface = compact.surfaces.find(
      (candidate) => candidate.surfaceId === surface.surfaceId,
    );
    for (const requiredSlot of expectedSlots) {
      if (!compactSurface?.slots.includes(requiredSlot)) {
        add(
          violations,
          'SG009_COMPACT_SLOT',
          surface.surfaceId,
          `compact projection omitted required slot ${requiredSlot}`,
        );
      }
    }
  }

  if (active.length > SURFACE_GRAMMAR_LIMITS.desktopNavigationItems) {
    add(
      violations,
      'SG007_DESKTOP_NAVIGATION_BUDGET',
      'navigation',
      `desktop navigation observed ${active.length} items; maximum is ${SURFACE_GRAMMAR_LIMITS.desktopNavigationItems}`,
    );
  }
  if (
    compact.navigationSurfaceIds.length >
    SURFACE_GRAMMAR_LIMITS.compactNavigationItems
  ) {
    add(
      violations,
      'SG008_COMPACT_NAVIGATION_BUDGET',
      'navigation',
      `compact navigation observed ${compact.navigationSurfaceIds.length} items; maximum is ${SURFACE_GRAMMAR_LIMITS.compactNavigationItems}`,
    );
  }

  return Object.freeze({
    compactSurfacesRead: compact.surfaces.length,
    surfacesRead: active.length,
    violations: Object.freeze(violations),
  });
}

export function checkSurfaceAccessibility(
  contrastPairs: readonly ContrastPair[],
  targets: readonly TargetMeasurement[],
): AccessibilityCheckResult {
  const violations: SurfaceGrammarViolation[] = [];
  for (const pair of contrastPairs) {
    const ratio = contrastRatio(pair.foreground, pair.background);
    if (ratio < SURFACE_GRAMMAR_LIMITS.minimumContrastRatio) {
      add(
        violations,
        'SG010_CONTRAST',
        pair.subjectId,
        `contrast ratio ${ratio.toFixed(2)} is below ${SURFACE_GRAMMAR_LIMITS.minimumContrastRatio.toFixed(1)}`,
      );
    }
  }
  for (const target of targets) {
    if (
      target.width < SURFACE_GRAMMAR_LIMITS.minimumTargetPixels ||
      target.height < SURFACE_GRAMMAR_LIMITS.minimumTargetPixels
    ) {
      add(
        violations,
        'SG011_TARGET_SIZE',
        target.subjectId,
        `target measured ${target.width}x${target.height}px; minimum is ${SURFACE_GRAMMAR_LIMITS.minimumTargetPixels}x${SURFACE_GRAMMAR_LIMITS.minimumTargetPixels}px`,
      );
    }
  }
  return Object.freeze({
    contrastPairsRead: contrastPairs.length,
    targetsRead: targets.length,
    violations: Object.freeze(violations),
  });
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function formatSurfaceGrammarResult(
  label: string,
  result: SurfaceGrammarCheckResult,
): string {
  const observation = `${result.surfacesRead} active surfaces read; ${result.compactSurfacesRead} compact surfaces read`;
  return result.violations.length === 0
    ? `${label}: PASS (${observation})`
    : `${label}: FAIL (${observation}; ${result.violations.length} violations)`;
}

function luminance(color: string): number {
  const match = color.match(/^#([0-9a-f]{6})$/i);
  if (!match?.[1]) throw new Error(`unsupported conformance color ${color}`);
  const channels = [0, 2, 4].map((offset) =>
    Number.parseInt(match[1]!.slice(offset, offset + 2), 16),
  );
  const linear = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function isArchetype(value: string): value is SurfaceArchetype {
  return SURFACE_ARCHETYPES.some((candidate) => candidate === value);
}

function add(
  violations: SurfaceGrammarViolation[],
  ruleId: SurfaceGrammarRuleId,
  subjectId: string,
  message: string,
): void {
  violations.push(Object.freeze({ message, ruleId, subjectId }));
}
