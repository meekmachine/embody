import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';

type ReferenceVector3 = Readonly<{ x: number; y: number; z: number }>;
type ReferenceQuaternion = Readonly<{ x: number; y: number; z: number; w: number }>;

export type ThreeReferencePoseNode = Readonly<{
  /** Child-index path relative to the captured model. The model itself has path ''. */
  path: string;
  parentPath: string | null;
  name: string;
  type: string;
  isBone: boolean;
  rotationOrder: Object3D['rotation']['order'];
  /** Authored Euler values for automatic TRS, including rotations beyond one turn. */
  rotationEuler?: ReferenceVector3;
  childCount: number;
  /** For manual matrices, this is a decomposition; matrices remain authoritative for shear. */
  transform: Readonly<{
    position: ReferenceVector3;
    rotation: ReferenceQuaternion;
    scale: ReferenceVector3;
  }>;
  /** Column-major local and world matrices, including shear and non-bone ancestors. */
  localMatrix: readonly number[];
  worldMatrix: readonly number[];
  worldPosition: ReferenceVector3;
  /** Optional morph baseline captured independently from later live influences. */
  morphInfluences?: readonly number[];
}>;

export type ThreeModelReferencePose = Readonly<{
  version: 1;
  /** Captured transform above the model root; identity for an unparented model. */
  parentWorldMatrix: readonly number[];
  nodes: readonly ThreeReferencePoseNode[];
}>;

const isBone = (object: Object3D) => !!((object as Object3D & { isBone?: boolean }).isBone || object.type === 'Bone');

const finite = (values: readonly number[], description: string) => {
  if (!values.every(Number.isFinite)) {
    throw new Error(`Cannot capture reference pose: ${description} contains non-finite values`);
  }
};

const matrixValues = (matrix: Matrix4, description: string): readonly number[] => {
  const values = matrix.elements.slice();
  finite(values, description);
  return Object.freeze(values);
};

const localMatrix = (object: Object3D) => object.matrixAutoUpdate
  ? new Matrix4().compose(object.position, object.quaternion, object.scale)
  : object.matrix.clone();

const referenceTransform = (object: Object3D, matrix: Matrix4): ThreeReferencePoseNode['transform'] => {
  // Manual matrices can contain shear that TRS cannot represent exactly. Retain the
  // original matrix independently and expose a decomposition only for TRS consumers.
  const position = object.matrixAutoUpdate ? object.position : new Vector3();
  const rotation = object.matrixAutoUpdate ? object.quaternion : new Quaternion();
  const scale = object.matrixAutoUpdate ? object.scale : new Vector3();
  if (!object.matrixAutoUpdate) matrix.decompose(position, rotation, scale);
  finite([...position.toArray(), ...rotation.toArray(), ...scale.toArray()], `transform for ${JSON.stringify(object.name)}`);
  return Object.freeze({
    position: Object.freeze({ x: position.x, y: position.y, z: position.z }),
    rotation: Object.freeze({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }),
    scale: Object.freeze({ x: scale.x, y: scale.y, z: scale.z }),
  });
};

const captureSubtree = (
  object: Object3D,
  path: string,
  parentPath: string | null,
  parentMatrix: Matrix4,
  nodes: ThreeReferencePoseNode[],
) => {
  const local = localMatrix(object);
  const localValues = matrixValues(local, `local matrix at ${JSON.stringify(path)}`);
  const world = new Matrix4().multiplyMatrices(parentMatrix, local);
  const worldValues = matrixValues(world, `world matrix at ${JSON.stringify(path)}`);
  const influences = (object as Object3D & { morphTargetInfluences?: readonly number[] }).morphTargetInfluences;
  const morphInfluences = influences === undefined ? undefined : Array.from(influences);
  if (morphInfluences) finite(morphInfluences, `morph influences at ${JSON.stringify(path)}`);
  const rotationEuler = object.matrixAutoUpdate
    ? { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z }
    : undefined;
  if (rotationEuler) finite(Object.values(rotationEuler), `Euler rotation at ${JSON.stringify(path)}`);
  nodes.push(Object.freeze({
    path,
    parentPath,
    name: object.name,
    type: object.type,
    isBone: isBone(object),
    rotationOrder: object.rotation.order,
    ...(rotationEuler ? { rotationEuler: Object.freeze(rotationEuler) } : {}),
    childCount: object.children.length,
    transform: referenceTransform(object, local),
    localMatrix: localValues,
    worldMatrix: worldValues,
    worldPosition: Object.freeze({ x: worldValues[12], y: worldValues[13], z: worldValues[14] }),
    ...(morphInfluences ? { morphInfluences: Object.freeze(morphInfluences) } : {}),
  }));
  object.children.forEach((child, index) => captureSubtree(child, `${path}/${index}`, path, world, nodes));
};

const matchesNode = (object: Object3D, node: ThreeReferencePoseNode | undefined, path: string, parentPath: string | null) =>
  node !== undefined
    && node.path === path
    && node.parentPath === parentPath
    && node.name === object.name
    && node.type === object.type
    && node.isBone === isBone(object);

const incompatible = (object: Object3D, path: string) =>
  new Error(`Incompatible reference pose hierarchy at ${JSON.stringify(path)} (${JSON.stringify(object.name)})`);

/**
 * Explicitly capture the authored reference pose before starting animation.
 * This does not infer a skin bind pose or animation frame zero: it snapshots the
 * transforms supplied by the caller, without updating or otherwise mutating the scene.
 * World matrices are calculated from the full ancestor chain's local transforms,
 * not potentially stale matrixWorld values. All returned data is deeply frozen and
 * JSON-serializable; no object, UUID, or live transform references are retained.
 * Existing morph influences are copied as an optional baseline. Non-finite data
 * or manual matrices without a finite TRS decomposition throw.
 */
export function captureModelReferencePose(model: Object3D): ThreeModelReferencePose {
  const ancestors: Object3D[] = [];
  for (let ancestor = model.parent; ancestor; ancestor = ancestor.parent) ancestors.push(ancestor);
  const parentWorld = new Matrix4();
  for (const ancestor of ancestors.reverse()) parentWorld.multiply(localMatrix(ancestor));
  const parentWorldMatrix = matrixValues(parentWorld, 'parent world matrix');
  const nodes: ThreeReferencePoseNode[] = [];

  captureSubtree(model, '', null, parentWorld, nodes);
  return Object.freeze({ version: 1, parentWorldMatrix, nodes: Object.freeze(nodes) });
}

/**
 * Explicitly extend a reference after appending children, such as a generated
 * skeleton. Existing structural paths, names, kinds and child order must match;
 * removing or inserting before an existing child is incompatible. Existing
 * captured data remains unchanged except child counts. Newly appended subtrees
 * use their current local transforms beneath the CAPTURED parent world matrix,
 * so playback and later scene placement never become the old rig's reference.
 * Returns a new deeply frozen snapshot without mutating the model or previous
 * data. Identical sibling swaps cannot be distinguished by structural identity.
 */
export function extendModelReferencePose(
  model: Object3D,
  previous: ThreeModelReferencePose,
): ThreeModelReferencePose {
  if (previous.version !== 1) throw new Error('Unsupported model reference pose version');
  const nodes: ThreeReferencePoseNode[] = [];
  let index = 0;
  const extend = (object: Object3D, path: string, parentPath: string | null) => {
    const node = previous.nodes[index++];
    if (!matchesNode(object, node, path, parentPath) || object.children.length < node.childCount) {
      throw incompatible(object, path);
    }
    // Copy even a deserialized snapshot into frozen data; never freeze or mutate
    // the caller's input, or reuse any current transform/morph values here.
    nodes.push(Object.freeze({
      ...node,
      childCount: object.children.length,
      transform: Object.freeze({
        position: Object.freeze({ ...node.transform.position }),
        rotation: Object.freeze({ ...node.transform.rotation }),
        scale: Object.freeze({ ...node.transform.scale }),
      }),
      localMatrix: Object.freeze([...node.localMatrix]),
      worldMatrix: Object.freeze([...node.worldMatrix]),
      worldPosition: Object.freeze({ ...node.worldPosition }),
      ...(node.rotationEuler ? { rotationEuler: Object.freeze({ ...node.rotationEuler }) } : {}),
      ...(node.morphInfluences ? { morphInfluences: Object.freeze([...node.morphInfluences]) } : {}),
    }));
    for (let childIndex = 0; childIndex < node.childCount; childIndex += 1) {
      extend(object.children[childIndex], `${path}/${childIndex}`, path);
    }
    const parentWorld = new Matrix4().fromArray(node.worldMatrix);
    for (let childIndex = node.childCount; childIndex < object.children.length; childIndex += 1) {
      captureSubtree(object.children[childIndex], `${path}/${childIndex}`, path, parentWorld, nodes);
    }
  };
  extend(model, '', null);
  if (index !== previous.nodes.length) throw new Error('Incompatible reference pose hierarchy: extra captured nodes');
  return Object.freeze({
    version: 1,
    parentWorldMatrix: Object.freeze([...previous.parentWorldMatrix]),
    nodes: Object.freeze(nodes),
  });
}

/**
 * Resolve captured data against an identically structured model, including a fresh
 * clone/load with new UUIDs. Names, types, bone flags, and child ordering must match;
 * duplicate names are distinguished by structural path, never name lookup.
 * Current transforms and the model's external scene parent are deliberately ignored.
 * An incompatible hierarchy throws before a binding map is returned.
 */
export function bindModelReferencePose(
  model: Object3D,
  referencePose: ThreeModelReferencePose,
): ReadonlyMap<Object3D, ThreeReferencePoseNode> {
  if (referencePose.version !== 1) throw new Error('Unsupported model reference pose version');
  const bindings = new Map<Object3D, ThreeReferencePoseNode>();
  let index = 0;
  const bind = (object: Object3D, path: string, parentPath: string | null) => {
    const node = referencePose.nodes[index++];
    if (!matchesNode(object, node, path, parentPath) || node.childCount !== object.children.length) {
      throw incompatible(object, path);
    }
    bindings.set(object, node);
    object.children.forEach((child, childIndex) => bind(child, `${path}/${childIndex}`, path));
  };
  bind(model, '', null);
  if (index !== referencePose.nodes.length) throw new Error('Incompatible reference pose hierarchy: extra captured nodes');
  return bindings;
}
