export abstract class WorkflowBase<TResult> {
  async tryHandle(input: string): Promise<TResult | null> {
    if (!this.matches(input)) {
      return null;
    }

    return this.handleMatched(input);
  }

  protected abstract matches(input: string): boolean;
  protected abstract handleMatched(input: string): Promise<TResult | null>;
}