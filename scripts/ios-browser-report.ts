import type { Reporter, TestModule } from 'vitest/node'
import type { Json, VitestEnd } from 'waffle/testing/page-runner/framework'
import { errorJson } from './ios-browser-records.ts'

function moduleErrors(module: TestModule): Json[] {
  const suites = Array.from(module.children.allSuites(), (suite) => suite.errors()).flat()
  const tests = Array.from(module.children.allTests(), (test) => test.result()).flatMap((result) =>
    result.state === 'failed' ? result.errors : [],
  )
  return module
    .errors()
    .concat(suites, tests)
    .map((error) => errorJson(error))
}

export function frameworkEndReporter(): { reporter: Reporter; endStatus: () => VitestEnd } {
  let end: VitestEnd | undefined
  return {
    reporter: {
      onTestRunEnd(modules, errors, reason) {
        if (reason === 'passed' && errors.length === 0 && modules.every((module) => module.ok())) {
          end = { status: 'passed' }
          return
        }
        end = {
          status: reason === 'interrupted' ? 'interrupted' : 'failed',
          errors: errors.map((error) => errorJson(error)).concat(modules.flatMap(moduleErrors)),
        }
      },
    },
    endStatus() {
      if (!end) throw new Error('No ordinary Vitest end event')
      return end
    },
  }
}
