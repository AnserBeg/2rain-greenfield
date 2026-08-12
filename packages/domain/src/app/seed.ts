import { APPLICATION_IDS } from './builder.js';

/**
 * Seed records for the composed application, authored beside the module
 * definitions they populate and bound to `APPLICATION_IDS` rather than to
 * reconstructed identifier strings. A seed that rebuilds `namespace:field.x`
 * by concatenation is a second authority for the module's field identity: it
 * keeps compiling after the module renames a field, and drifts silently.
 *
 * Two profiles, because two callers want different things from the same
 * definitions:
 *
 * - `demo` is the small fixed fixture the browser suite asserts against. Its
 *   records, ordinals and values are frozen; changing one changes a reviewed
 *   test's subject.
 * - `distributor` is `demo` plus enough volume that a human can judge the
 *   surfaces — lists that paginate against the modules' declared
 *   `maximumResultCount` of 100, and a party set worth searching. It is a
 *   superset, so every fact the `demo` profile establishes still holds.
 */

export interface ComposedApplicationSeedRecord {
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly recordId: string;
  readonly values: Readonly<Record<string, string>>;
}

export type ComposedApplicationSeedProfile = 'demo' | 'distributor';

const warehouseOptionId = `${APPLICATION_IDS.namespace}:option.warehouse`;
const storeOptionId = `${APPLICATION_IDS.namespace}:option.store`;

/**
 * Ordinal blocks. `demo` occupies 1-4 / 11-14 / 21-24 and must keep those
 * exact values: its record identifiers are derived from them, and the browser
 * suite reads the records back by name. Additional volume is allocated in
 * disjoint blocks above 1000 so the two profiles can never collide.
 */
const demoParties = [
  ['P-1001', 'Alpine Office Supply', 'Purchasing · ap@alpine.example'],
  ['P-1002', 'Northwind Goods', 'Wholesale · orders@northwind.example'],
  ['P-1003', 'Prairie Paper Co.', 'Local delivery · hello@prairie.example'],
  ['P-1004', 'Summit Industrial', 'Preferred supplier · team@summit.example'],
] as const;

const demoItems = [
  ['OFF-100', 'Field notebook', 'Recycled ruled notebook, 80 pages', 'EA'],
  [
    'OFF-120',
    'Fine-point pen set',
    'Black fine-point pens, pack of twelve',
    'BOX',
  ],
  ['OFF-210', 'Task lamp', 'Adjustable task lamp, forest green', 'EA'],
  [
    'OPS-310',
    'Shipping labels',
    'Compostable shipping labels, pack of 100',
    'PACK',
  ],
] as const;

const demoLocations = [
  ['CAL-WH', 'Calgary warehouse', warehouseOptionId],
  ['EDM-ST', 'Edmonton store', storeOptionId],
  ['VAN-WH', 'Vancouver warehouse', warehouseOptionId],
  ['YYC-ST', 'Beltline store', storeOptionId],
] as const;

/** Trading partners for the distributor profile: suppliers, then customers. */
const distributorParties = [
  ['Cascade Fastener Works', 'Supplier · sales@cascadefastener.example'],
  ['Bow River Abrasives', 'Supplier · orders@bowriverabrasives.example'],
  ['Kootenay Safety Supply', 'Supplier · ap@kootenaysafety.example'],
  ['Redwater Electrical', 'Supplier · purchasing@redwaterelec.example'],
  ['Foothills Packaging', 'Supplier · info@foothillspack.example'],
  ['Chinook Tool & Die', 'Supplier · sales@chinooktool.example'],
  ['Athabasca Janitorial', 'Supplier · orders@athabascajan.example'],
  ['Selkirk Adhesives', 'Supplier · ap@selkirkadhesives.example'],
  ['Peace River Lubricants', 'Supplier · sales@peaceriverlube.example'],
  ['Fraser Valley Hardware', 'Supplier · orders@fraservalleyhw.example'],
  ['Okanagan Welding Supply', 'Supplier · info@okwelding.example'],
  ['Milk River Plastics', 'Supplier · ap@milkriverplastics.example'],
  ['Bonnyville Steel', 'Supplier · sales@bonnyvillesteel.example'],
  ['Sturgeon Bearing Co.', 'Supplier · orders@sturgeonbearing.example'],
  ['Wetaskiwin Filtration', 'Supplier · info@wetaskiwinfilt.example'],
  ['Lethbridge Millwork', 'Customer · ap@lethbridgemillwork.example'],
  ['Grande Cache Mining Services', 'Customer · purchasing@gcmining.example'],
  ['Airdrie Auto Group', 'Customer · parts@airdrieauto.example'],
  ['Sherwood Park Facilities', 'Customer · facilities@shpk.example'],
  ['Canmore Hospitality Group', 'Customer · ops@canmorehg.example'],
  ['Red Deer Fabrication', 'Customer · ap@rdfabrication.example'],
  ['Medicine Hat Greenhouses', 'Customer · orders@mhgreenhouse.example'],
  [
    'Fort Saskatchewan Utilities',
    'Customer · procurement@fortsaskutil.example',
  ],
  ['Kelowna Property Care', 'Customer · admin@kelownapropcare.example'],
  ['Nanaimo Marine Works', 'Customer · parts@nanaimomarine.example'],
  ['Whitecourt Forestry', 'Customer · supply@whitecourtforest.example'],
  ['Brooks Food Processing', 'Customer · ap@brooksfood.example'],
  ['Camrose School Division', 'Customer · purchasing@camrosesd.example'],
  ['Drumheller Tourism Board', 'Customer · ops@drumhellertb.example'],
  ['Hinton Pulp Services', 'Customer · maintenance@hintonpulp.example'],
  ['Leduc Aviation Support', 'Customer · stores@leducaviation.example'],
  ['Cochrane Ranch Supply', 'Customer · orders@cochraneranch.example'],
  ['Vernon Cold Storage', 'Customer · ap@vernoncold.example'],
  ['Squamish Adventure Rentals', 'Customer · gear@squamishrentals.example'],
  ['Yellowhead Transport', 'Customer · fleet@yellowheadtransport.example'],
  ['Strathmore Irrigation', 'Customer · parts@strathmoreirr.example'],
  ['Ponoka Livestock Equipment', 'Customer · orders@ponokalivestock.example'],
  ['Revelstoke Ski Operations', 'Customer · maintenance@revelstokeski.example'],
  ['Slave Lake Contracting', 'Customer · ap@slavelakecontract.example'],
  ['Beaumont Municipal Works', 'Customer · works@beaumontmuni.example'],
  ['Chestermere Dental Group', 'Customer · admin@chestermeredental.example'],
] as const;

/**
 * Item families expanded into variants. Authoring families rather than 136
 * literal rows keeps the vocabulary readable while still producing SKUs,
 * names and descriptions a human recognises as a real catalogue.
 */
interface ItemFamily {
  readonly baseUnit: string;
  readonly descriptionOf: (variant: string) => string;
  readonly name: string;
  readonly prefix: string;
  readonly variants: readonly string[];
}

const itemFamilies: readonly ItemFamily[] = [
  {
    baseUnit: 'BOX',
    descriptionOf: (variant) => `Zinc-plated hex bolt, ${variant}, grade 8.8`,
    name: 'Hex bolt',
    prefix: 'FST-01',
    variants: [
      'M6 × 25 mm',
      'M8 × 40 mm',
      'M10 × 50 mm',
      'M12 × 60 mm',
      'M16 × 80 mm',
    ],
  },
  {
    baseUnit: 'BOX',
    descriptionOf: (variant) => `Stainless nyloc lock nut, ${variant}`,
    name: 'Lock nut',
    prefix: 'FST-02',
    variants: ['M6', 'M8', 'M10', 'M12'],
  },
  {
    baseUnit: 'BOX',
    descriptionOf: (variant) => `Flat washer, ${variant}, hot-dip galvanised`,
    name: 'Flat washer',
    prefix: 'FST-03',
    variants: ['M6', 'M8', 'M10', 'M12', 'M16'],
  },
  {
    baseUnit: 'PACK',
    descriptionOf: (variant) => `Self-drilling screw, ${variant}, pack of 200`,
    name: 'Self-drilling screw',
    prefix: 'FST-04',
    variants: ['8 × 20 mm', '10 × 25 mm', '12 × 32 mm'],
  },
  {
    baseUnit: 'PACK',
    descriptionOf: (variant) =>
      `Resin fibre sanding disc, ${variant}, pack of 25`,
    name: 'Sanding disc',
    prefix: 'ABR-01',
    variants: ['40 grit', '60 grit', '80 grit', '120 grit', '180 grit'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) => `Reinforced cut-off wheel, ${variant}`,
    name: 'Cut-off wheel',
    prefix: 'ABR-02',
    variants: ['115 mm', '125 mm', '180 mm', '230 mm'],
  },
  {
    baseUnit: 'ROLL',
    descriptionOf: (variant) => `Aluminium-oxide abrasive roll, ${variant}`,
    name: 'Abrasive roll',
    prefix: 'ABR-03',
    variants: ['80 grit × 25 m', '120 grit × 25 m', '180 grit × 25 m'],
  },
  {
    baseUnit: 'PAIR',
    descriptionOf: (variant) => `Cut-resistant work glove, ${variant}, ANSI A4`,
    name: 'Work glove',
    prefix: 'SAF-01',
    variants: ['small', 'medium', 'large', 'X-large', 'XX-large'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) =>
      `Class E hard hat, ${variant}, 4-point suspension`,
    name: 'Hard hat',
    prefix: 'SAF-02',
    variants: ['white', 'yellow', 'orange', 'blue'],
  },
  {
    baseUnit: 'BOX',
    descriptionOf: (variant) =>
      `Safety eyewear, ${variant}, anti-fog, box of 12`,
    name: 'Safety glasses',
    prefix: 'SAF-03',
    variants: ['clear lens', 'smoke lens', 'amber lens'],
  },
  {
    baseUnit: 'CASE',
    descriptionOf: (variant) =>
      `Disposable respirator, ${variant}, case of 160`,
    name: 'Respirator',
    prefix: 'SAF-04',
    variants: ['N95 cup', 'N95 fold-flat', 'P100 half-mask'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) =>
      `High-visibility safety vest, ${variant}, class 2`,
    name: 'Safety vest',
    prefix: 'SAF-05',
    variants: ['medium', 'large', 'X-large', 'XX-large'],
  },
  {
    baseUnit: 'ROLL',
    descriptionOf: (variant) =>
      `Stranded building wire, ${variant}, 150 m roll`,
    name: 'Building wire',
    prefix: 'ELE-01',
    variants: ['14 AWG', '12 AWG', '10 AWG', '8 AWG'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) => `Weatherproof junction box, ${variant}`,
    name: 'Junction box',
    prefix: 'ELE-02',
    variants: ['4 in square', '6 in square', '8 in square'],
  },
  {
    baseUnit: 'BOX',
    descriptionOf: (variant) => `LED high-bay luminaire, ${variant}, 5000 K`,
    name: 'LED high bay',
    prefix: 'ELE-03',
    variants: ['100 W', '150 W', '200 W'],
  },
  {
    baseUnit: 'PACK',
    descriptionOf: (variant) => `Cable tie, ${variant}, UV-stable, pack of 100`,
    name: 'Cable tie',
    prefix: 'ELE-04',
    variants: ['150 mm', '200 mm', '300 mm', '400 mm'],
  },
  {
    baseUnit: 'ROLL',
    descriptionOf: (variant) => `Corrugated stretch wrap, ${variant}`,
    name: 'Stretch wrap',
    prefix: 'PKG-01',
    variants: ['450 mm × 300 m', '500 mm × 400 m'],
  },
  {
    baseUnit: 'CASE',
    descriptionOf: (variant) =>
      `Double-wall shipping carton, ${variant}, case of 25`,
    name: 'Shipping carton',
    prefix: 'PKG-02',
    variants: [
      '305 × 305 × 305 mm',
      '406 × 406 × 406 mm',
      '457 × 305 × 305 mm',
    ],
  },
  {
    baseUnit: 'ROLL',
    descriptionOf: (variant) => `Pressure-sensitive packing tape, ${variant}`,
    name: 'Packing tape',
    prefix: 'PKG-03',
    variants: ['48 mm clear', '48 mm buff', '72 mm clear'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) => `Cordless impact driver, ${variant}, brushless`,
    name: 'Impact driver',
    prefix: 'TOL-01',
    variants: ['12 V', '18 V', '18 V high-torque'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) =>
      `Combination wrench, ${variant}, chrome vanadium`,
    name: 'Combination wrench',
    prefix: 'TOL-02',
    variants: ['10 mm', '13 mm', '17 mm', '19 mm', '22 mm', '24 mm'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) => `Tape measure, ${variant}, nylon-coated blade`,
    name: 'Tape measure',
    prefix: 'TOL-03',
    variants: ['5 m', '8 m', '10 m'],
  },
  {
    baseUnit: 'CASE',
    descriptionOf: (variant) => `Neutral floor cleaner, ${variant}, case of 4`,
    name: 'Floor cleaner',
    prefix: 'JAN-01',
    variants: ['4 L concentrate', '10 L concentrate'],
  },
  {
    baseUnit: 'CASE',
    descriptionOf: (variant) =>
      `Centre-pull paper towel, ${variant}, case of 6`,
    name: 'Paper towel',
    prefix: 'JAN-02',
    variants: ['600 sheet', '800 sheet'],
  },
  {
    baseUnit: 'CASE',
    descriptionOf: (variant) =>
      `Low-density can liner, ${variant}, case of 200`,
    name: 'Can liner',
    prefix: 'JAN-03',
    variants: ['75 L', '120 L', '200 L'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) => `Shielded ball bearing, ${variant}`,
    name: 'Ball bearing',
    prefix: 'MRO-01',
    variants: ['6202-2RS', '6204-2RS', '6206-2RS', '6208-2RS'],
  },
  {
    baseUnit: 'CASE',
    descriptionOf: (variant) => `Extreme-pressure lithium grease, ${variant}`,
    name: 'Lithium grease',
    prefix: 'MRO-02',
    variants: ['400 g cartridge', '18 kg pail'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) => `Pleated air filter, ${variant}, MERV 8`,
    name: 'Air filter',
    prefix: 'MRO-03',
    variants: ['16 × 20 in', '20 × 20 in', '20 × 25 in', '24 × 24 in'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) => `V-belt drive belt, ${variant}`,
    name: 'Drive belt',
    prefix: 'MRO-04',
    variants: ['A-32', 'A-42', 'B-48', 'B-60'],
  },
  {
    baseUnit: 'BOX',
    descriptionOf: (variant) => `Hydraulic hose fitting, ${variant}, JIC 37°`,
    name: 'Hose fitting',
    prefix: 'MRO-05',
    variants: ['1/4 in', '3/8 in', '1/2 in', '3/4 in'],
  },
  {
    baseUnit: 'PACK',
    descriptionOf: (variant) =>
      `Thermal transfer label, ${variant}, pack of 1000`,
    name: 'Thermal label',
    prefix: 'OPS-01',
    variants: ['100 × 150 mm', '75 × 100 mm'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) => `Warehouse storage bin, ${variant}, stackable`,
    name: 'Storage bin',
    prefix: 'OPS-02',
    variants: ['small', 'medium', 'large'],
  },
  {
    baseUnit: 'EA',
    descriptionOf: (variant) => `Steel shelving unit, ${variant}, 5 shelves`,
    name: 'Shelving unit',
    prefix: 'OPS-03',
    variants: ['900 × 400 mm', '1200 × 450 mm', '1200 × 600 mm'],
  },
];

const distributorLocations = [
  ['CAL-OV', 'Calgary overflow yard', warehouseOptionId],
  ['EDM-WH', 'Edmonton warehouse', warehouseOptionId],
  ['RDR-ST', 'Red Deer store', storeOptionId],
  ['LTH-ST', 'Lethbridge store', storeOptionId],
  ['SAS-WH', 'Saskatoon warehouse', warehouseOptionId],
  ['WPG-WH', 'Winnipeg warehouse', warehouseOptionId],
  ['KEL-ST', 'Kelowna store', storeOptionId],
  ['PGE-ST', 'Prince George store', storeOptionId],
] as const;

/**
 * The seed for a profile. `distributor` is `demo` followed by its additional
 * records, so the two profiles agree on every record the smaller one defines.
 */
export function composedApplicationSeed(
  profile: ComposedApplicationSeedProfile,
): readonly ComposedApplicationSeedRecord[] {
  const records = [
    ...demoParties.map(([number, name, contactSummary], index) =>
      partyRecord(index + 1, number, name, contactSummary),
    ),
    ...demoItems.map(([sku, name, description, baseUnit], index) =>
      itemRecord(index + 11, sku, name, description, baseUnit),
    ),
    ...demoLocations.map(([code, name, locationType], index) =>
      locationRecord(index + 21, code, name, locationType),
    ),
  ];
  if (profile === 'demo') return Object.freeze(records);

  records.push(
    ...distributorParties.map(([name, contactSummary], index) =>
      partyRecord(
        1001 + index,
        `P-${String(2001 + index)}`,
        name,
        contactSummary,
      ),
    ),
    ...distributorItems(),
    ...distributorLocations.map(([code, name, locationType], index) =>
      locationRecord(3001 + index, code, name, locationType),
    ),
  );
  return Object.freeze(records);
}

function distributorItems(): readonly ComposedApplicationSeedRecord[] {
  const records: ComposedApplicationSeedRecord[] = [];
  let ordinal = 2001;
  for (const family of itemFamilies) {
    for (const [index, variant] of family.variants.entries()) {
      records.push(
        itemRecord(
          ordinal,
          `${family.prefix}${String((index + 1) * 10).padStart(2, '0')}`,
          `${family.name} — ${variant}`,
          family.descriptionOf(variant),
          family.baseUnit,
        ),
      );
      ordinal += 1;
    }
  }
  return records;
}

function partyRecord(
  ordinal: number,
  number: string,
  name: string,
  contactSummary: string,
): ComposedApplicationSeedRecord {
  return record(ordinal, APPLICATION_IDS.party.createOperationId, {
    [APPLICATION_IDS.party.fieldIds.contactSummary]: contactSummary,
    [APPLICATION_IDS.party.fieldIds.name]: name,
    [APPLICATION_IDS.party.fieldIds.number]: number,
  });
}

function itemRecord(
  ordinal: number,
  sku: string,
  name: string,
  description: string,
  baseUnit: string,
): ComposedApplicationSeedRecord {
  return record(ordinal, APPLICATION_IDS.catalog.createOperationId, {
    [APPLICATION_IDS.catalog.fieldIds.baseUnit]: baseUnit,
    [APPLICATION_IDS.catalog.fieldIds.description]: description,
    [APPLICATION_IDS.catalog.fieldIds.name]: name,
    [APPLICATION_IDS.catalog.fieldIds.sku]: sku,
  });
}

function locationRecord(
  ordinal: number,
  code: string,
  name: string,
  locationType: string,
): ComposedApplicationSeedRecord {
  // Key ORDER matters and is not cosmetic: the previous inline seed inserted
  // code, then name, then type. Property order survives JSON.stringify, so a
  // different order is different bytes even though the map is equal. The
  // control asserts exact serialized equality against the recorded prior seed.
  return record(ordinal, APPLICATION_IDS.location.createOperationId, {
    [APPLICATION_IDS.location.fieldIds.code]: code,
    [APPLICATION_IDS.location.fieldIds.name]: name,
    [APPLICATION_IDS.location.fieldIds.locationType]: locationType,
  });
}

function record(
  ordinal: number,
  operationId: string,
  values: Readonly<Record<string, string>>,
): ComposedApplicationSeedRecord {
  const suffix = String(ordinal).padStart(12, '0');
  return Object.freeze({
    idempotencyKey: `72000000-0000-4000-8000-${suffix}`,
    operationId,
    recordId: `71000000-0000-4000-8000-${suffix}`,
    values: Object.freeze(values),
  });
}
