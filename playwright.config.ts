import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:30_000,expect:{timeout:5000},
  use:{browserName:'chromium',headless:true,viewport:{width:1280,height:900},trace:'off',screenshot:'only-on-failure'},reporter:'list'});
