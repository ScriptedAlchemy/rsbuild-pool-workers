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

const workersAsyncConfigFactory = defineWorkersConfig(async function (
  this: { mode: string },
  command: "watch",
  retries: number
) {
  return {
    include: [`${this.mode}:${command}:${retries}`],
    workers: {
      main: "./src/async-index.ts"
    }
  };
});

type _WorkersAsyncConfigFactoryThis = Assert<
  IsExact<
    ThisParameterType<typeof workersAsyncConfigFactory>,
    { mode: string }
  >
>;
type _WorkersAsyncConfigFactoryArgs = Assert<
  IsExact<
    Parameters<typeof workersAsyncConfigFactory>,
    ["watch", number]
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

const workersProjectAsyncFactory = defineWorkersProject(async function (
  this: { mode: string },
  command: "ci"
) {
  return {
    include: [`${this.mode}:${command}`],
    workers: {
      main: "./src/project-async.ts"
    }
  };
});

type _WorkersProjectAsyncFactoryThis = Assert<
  IsExact<
    ThisParameterType<typeof workersProjectAsyncFactory>,
    { mode: string }
  >
>;
type _WorkersProjectAsyncFactoryArgs = Assert<
  IsExact<
    Parameters<typeof workersProjectAsyncFactory>,
    ["ci"]
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

const mappedAsyncFactory = mapAnyConfigExport(
  (value) => ({
    ...value,
    include: [...(value.include ?? []), "mapped-async"]
  }),
  async function (this: { source: string }, flag: boolean, multiplier: number) {
    return {
      include: [this.source, String(flag ? multiplier : 0)]
    } satisfies RstestConfig;
  }
);

type _MappedAsyncFactoryThis = Assert<
  IsExact<
    ThisParameterType<typeof mappedAsyncFactory>,
    { source: string }
  >
>;
type _MappedAsyncFactoryArgs = Assert<
  IsExact<
    Parameters<typeof mappedAsyncFactory>,
    [boolean, number]
  >
>;
