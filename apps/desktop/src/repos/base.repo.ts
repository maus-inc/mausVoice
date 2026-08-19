/**
 * Marker base class for repository implementations. Subclasses define the
 * interface + local/remote implementations resolved by the repos index.
 */
export abstract class BaseRepo {
  protected readonly initializedAt = Date.now();
}
