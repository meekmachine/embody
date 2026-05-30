export type NumericArray = readonly number[] | Float32Array;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface Transform {
  readonly position?: Vec3;
  readonly rotation?: Quat;
  readonly scale?: Vec3;
}
