/**
 * Define a user-controlled key as a normal enumerable own data property.
 *
 * Bracket assignment is not safe for keys such as `__proto__` on ordinary
 * objects because it can invoke an inherited setter instead of storing data.
 */
export function defineEnumerableOwn<T extends object>(
  record: T,
  key: PropertyKey,
  value: unknown,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
