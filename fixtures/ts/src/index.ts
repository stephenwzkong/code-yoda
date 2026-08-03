import { Service } from './service.ts'

export function main(): string {
  return new Service().run()
}

main()
