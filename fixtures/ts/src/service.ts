import { Greeter, helper } from './util.ts'

export class Service {
  run(): string {
    const greeter = new Greeter('world')
    return `${greeter.greet()} / ${helper('direct')}`
  }
}

export function unused(): void {}
