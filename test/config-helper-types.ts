import type { RstestConfig } from "@rstest/core";
import { defineWorkersConfig, defineWorkersProject } from "../src/config/index";
import { mapAnyConfigExport } from "../src/config/types";

type Assert<T extends true> = T;
type IsExact<T, U> =
  (<G>() => G extends T ? 1 : 2) extends
  (<G>() => G extends U ? 1 : 2)
    ? true
    : false;

const workersConfigFactory = defineWorkersConfig(function (
  this: { mode: string },
  command: "test" | "serve",
  retries: number
) {
  return {
    include: [`${command}:${retries}`],
    workers: {
      main: "./src/index.ts"
    }
  };
});

type _WorkersConfigFactoryThis = Assert<
  IsExact<
    ThisParameterType<typeof workersConfigFactory>,
    { mode: string }
  >
>;
type _WorkersConfigFactoryArgs = Assert<
  IsExact<
    Parameters<typeof workersConfigFactory>,
    ["test" | "serve", number]
  >
>;

const workersProjectFactory = defineWorkersProject(function (
  this: { mode: string },
  command: "dev"
) {
  return Promise.resolve({
    include: [`${this.mode}:${command}`],
    workers: {
      main: "./src/project.ts"
    }
  });
});

type _WorkersProjectFactoryThis = Assert<
  IsExact<
    ThisParameterType<typeof workersProjectFactory>,
    { mode: string }
  >
>;
type _WorkersProjectFactoryArgs = Assert<
  IsExact<
    Parameters<typeof workersProjectFactory>,
    ["dev"]
  >
>;

const mappedFactory = mapAnyConfigExport(
  (value) => ({
    ...value,
    include: [...(value.include ?? []), "mapped"]
  }),
  function (this: { source: string }, flag: boolean) {
    return {
      include: [this.source, flag ? "1" : "0"]
    } satisfies RstestConfig;
  }
);

type _MappedFactoryThis = Assert<
  IsExact<
    ThisParameterType<typeof mappedFactory>,
    { source: string }
  >
>;
type _MappedFactoryArgs = Assert<
  IsExact<
    Parameters<typeof mappedFactory>,
    [boolean]
  >
>;
