// Do not mock the numeric core: annotation regression tests use the shipped Wasm.
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
await initEmbodyCore();
