/** Formats a greeting. */
export function helper(name: string): string {
  return `hello ${name}`
}

export const arrow = (name: string): string => helper(name)

export class Greeter {
  constructor(private readonly name: string) {}

  greet(): string {
    return arrow(this.name)
  }
}
