export type MetadataScalar = null | boolean | number | string;
export interface MetadataMatch {
  readonly fields: readonly Readonly<{ path: readonly string[]; equals: MetadataScalar }>[];
}
export interface DeliveryDeferral {
  readonly id: string;
  readonly expiresAt: string;
}
