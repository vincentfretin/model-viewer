/* @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {BackSide, DoubleSide, FrontSide, Material, Mesh, MeshStandardMaterial, Object3D, Shader, sRGBEncoding, Texture, TextureLoader} from 'three';
import {GLTF} from 'three/examples/jsm/loaders/GLTFLoader.js';

import {$clone, $prepare, $preparedGLTF, GLTFInstance, PreparedGLTF} from '../GLTFInstance.js';
import {Renderer} from '../Renderer.js';
import {alphaChunk} from '../shader-chunk/alphatest_fragment.glsl.js';

import {CorrelatedSceneGraph} from './correlated-scene-graph.js';



const $cloneAndPatchMaterial = Symbol('cloneAndPatchMaterial');
const $correlatedSceneGraph = Symbol('correlatedSceneGraph');

interface PreparedModelViewerGLTF extends PreparedGLTF {
  [$correlatedSceneGraph]?: CorrelatedSceneGraph;
}

/**
 * This specialization of GLTFInstance collects all of the processing needed
 * to prepare a model and to clone it making special considerations for
 * <model-viewer> use cases.
 */
export class ModelViewerGLTFInstance extends GLTFInstance {
  /**
   * @override
   */
  protected static[$prepare](source: GLTF) {
    const prepared = super[$prepare](source) as PreparedModelViewerGLTF;

    if (prepared[$correlatedSceneGraph] == null) {
      prepared[$correlatedSceneGraph] = CorrelatedSceneGraph.from(prepared);
    }

    const {scene} = prepared;

    const meshesToDuplicate: Mesh[] = [];

    scene.traverse((node: Object3D) => {
      // Set a high renderOrder while we're here to ensure the model
      // always renders on top of the skysphere
      node.renderOrder = 1000;

      // Three.js seems to cull some animated models incorrectly. Since we
      // expect to view our whole scene anyway, we turn off the frustum
      // culling optimization here.
      node.frustumCulled = false;
      // Animations for objects without names target their UUID instead. When
      // objects are cloned, they get new UUIDs which the animation can't
      // find. To fix this, we assign their UUID as their name.
      if (!node.name) {
        node.name = node.uuid;
      }
      if (!(node as Mesh).isMesh) {
        return;
      }
      node.castShadow = true;
      const mesh = node as Mesh;
      let transparent = false;
      const materials =
          Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach(material => {
        if ((material as any).isMeshStandardMaterial) {
          if (material.transparent && material.side === DoubleSide) {
            transparent = true;
            material.side = FrontSide;
          }
        }
      });

      if (transparent) {
        meshesToDuplicate.push(mesh);
      }
    });

    // We duplicate transparent, double-sided meshes and render the back face
    // before the front face. This creates perfect triangle sorting for all
    // convex meshes. Sorting artifacts can still appear when you can see
    // through more than two layers of a given mesh, but this can usually be
    // mitigated by the author splitting the mesh into mostly convex regions.
    // The performance cost is not too great as the same shader is reused and
    // the same number of fragments are processed; only the vertex shader is run
    // twice. @see https://threejs.org/examples/webgl_materials_physical_transparency.html
    for (const mesh of meshesToDuplicate) {
      const materials =
          Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const duplicateMaterials = materials.map((material) => {
        const backMaterial = material.clone();
        backMaterial.side = BackSide;
        return backMaterial;
      });
      const duplicateMaterial = Array.isArray(mesh.material) ?
          duplicateMaterials :
          duplicateMaterials[0];
      const meshBack = mesh.clone() as Mesh;
      meshBack.material = duplicateMaterial;
      meshBack.renderOrder = -1;
      mesh.parent!.add(meshBack);
    }

    return prepared;
  }

  get correlatedSceneGraph() {
    return (
        this[$preparedGLTF] as PreparedModelViewerGLTF)[$correlatedSceneGraph]!;
  }

  /**
   * @override
   */
  [$clone](): PreparedGLTF {
    const clone: PreparedModelViewerGLTF = super[$clone]();
    const sourceUUIDToClonedMaterial = new Map<string, Material>();

    clone.scene.traverse((node: any) => {
      // Materials aren't cloned when cloning meshes; geometry
      // and materials are copied by reference. This is necessary
      // for the same model to be used twice with different
      // environment maps.
      if ((node as Mesh).isMesh) {
        const mesh = node as Mesh;
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map(
              (material) => this[$cloneAndPatchMaterial](
                  material as MeshStandardMaterial,
                  sourceUUIDToClonedMaterial));
        } else if (mesh.material != null) {
          mesh.material = this[$cloneAndPatchMaterial](
              mesh.material as MeshStandardMaterial,
              sourceUUIDToClonedMaterial);
          if (mesh.parent && mesh.parent.name === 'haircut_generated') {
            mesh.material.alphaTest =
                0;  // specific to model viewer that change the value
            mesh.material.transparent = true;
            mesh.material.depthWrite = false;
            mesh.material.needsUpdate = true;
          }
        }
      }
    });

    const model = clone.scene;
    const isWoman = model.getObjectByName('outfit_0_lowpoly') ||
        model.getObjectByName('outfit_2_lowpoly') ||
        model.getObjectByName('outfit_3_lowpoly') ||
        model.getObjectByName('outfit_meta_0_lowpoly') ||
        model.getObjectByName('outfit_meta_2_lowpoly') ||
        model.getObjectByName('outfit_meta_3_lowpoly');
    const outfits = [
      'outfit_0_lowpoly',
      'outfit_1_lowpoly',
      'outfit_2_lowpoly',
      'outfit_3_lowpoly',
      'outfit_4_lowpoly',
      'outfit_5_lowpoly',
      'outfit_meta_0_lowpoly',
      'outfit_meta_1_lowpoly',
      'outfit_meta_2_lowpoly',
      'outfit_meta_3_lowpoly',
      'outfit_meta_4_lowpoly',
      'outfit_meta_5_lowpoly',
    ];
    // keep outfit_2 by default for woman, outfit_4 for man
    const defaultOutfit = isWoman ? 'outfit_2_lowpoly' : 'outfit_4_lowpoly';
    const qs = new URLSearchParams(location.search);
    let selectedOutfit = qs.get('outfit') || defaultOutfit;
    let selectedOutfitVariant = null;
    const selectedOutfitParts = selectedOutfit.split('|');
    if (selectedOutfitParts.length === 2) {
      selectedOutfit = selectedOutfitParts[0];
      selectedOutfitVariant = selectedOutfitParts[1];
    }
    const isFitPerson = !!model.getObjectByName('L_Hip');
    const isMetaPerson = !!model.getObjectByName('RootNode');
    if (isMetaPerson) {
      // L_Hip is a bone of FitPerson, otherwise it's a MetaPerson, add the
      // meta_ prefix
      selectedOutfit = selectedOutfit.replace('outfit_', 'outfit_meta_');
    }
    const outfitObjects =
        outfits.map((outfitName) => model.getObjectByName(outfitName))
            .filter((o) => !!o);
    if (outfitObjects.length > 1) {
      outfitObjects.forEach((outfitObj) => {
        if (!outfitObj)
          return;
        outfitObj.visible = outfitObj.name === selectedOutfit;
        // New generated avatars have now depthWrite false and transparent true
        // wrongly set on outfit_meta_1_lowpoly and outfit_meta_4_lowpoly for
        // man. Be sure to revert that.
        if (outfitObj.type !== 'SkinnedMesh')
          outfitObj = outfitObj.children[0];
        // @ts-ignore
        outfitObj.material.alphaTest = 0;
        // @ts-ignore
        outfitObj.material.transparent = false;
        // @ts-ignore
        outfitObj.material.depthWrite = true;
        // @ts-ignore
        outfitObj.material.needsUpdate = true;
      });
    }

    const visibleOutfit =
        model.children.find((o) => o.name.startsWith('outfit') && o.visible);

    if (visibleOutfit) {
      // Keep the avatar invisible until we load the body visibility mask.
      model.visible = false;
      if (isFitPerson) {
        // Ankle and Foot rotation if outfit with high heels
        if (visibleOutfit.name.startsWith('outfit_0') ||
            visibleOutfit.name.startsWith('outfit_2')) {
          // @ts-ignore
          model.getObjectByName('L_Ankle').rotation.x = 0.35;
          // @ts-ignore
          model.getObjectByName('R_Ankle').rotation.x = 0.35;
          // @ts-ignore
          model.getObjectByName('L_Foot').rotation.x = -0.35;
          // @ts-ignore
          model.getObjectByName('R_Foot').rotation.x = -0.35;
        } else {
          // @ts-ignore
          model.getObjectByName('L_Ankle').rotation.x = 0;
          // @ts-ignore
          model.getObjectByName('R_Ankle').rotation.x = 0;
          // @ts-ignore
          model.getObjectByName('L_Foot').rotation.x = 0;
          // @ts-ignore
          model.getObjectByName('R_Foot').rotation.x = 0;
        }
      }
      if (isMetaPerson) {
        // @ts-ignore
        const lShoulder = model.getObjectByName('LeftShoulder');
        // @ts-ignore
        const rShoulder = model.getObjectByName('RightShoulder');
        // @ts-ignore
        const lArm = model.getObjectByName('LeftArm');
        // @ts-ignore
        const rArm = model.getObjectByName('RightArm');
        if (lShoulder && rShoulder && lArm && rArm) {
          // @ts-ignore
          lShoulder.rotation.set(
              1.529591413270602, -0.1685597219479182, -1.4382781866770025);
          // @ts-ignore
          lArm.rotation.set(
              1.2301263993071454, 0.5009548453080749, -0.11979616310890634);
          // @ts-ignore
          rShoulder.rotation.set(
              1.539083127857416, 0.24816855335072086, 1.5089718233866178);
          // @ts-ignore
          rArm.rotation.set(
              1.0119602384597257, -0.7067543561093879, 0.056597673806498765);
        }
      }

      let mesh = model.getObjectByName('mesh');
      if (mesh && mesh.type !== 'SkinnedMesh')
        mesh = mesh.children[0];
      if (mesh) {
        let outfit = visibleOutfit;
        if (outfit.type !== 'SkinnedMesh')
          outfit = outfit.children[0];
        const loader = new TextureLoader();
        let bodyVisibilityMaskLoaded = false;
        let outfitVariantLoaded = selectedOutfitVariant ? false : true;
        if (selectedOutfitVariant) {
          const outfitLoader = new TextureLoader();
          const outfitTextureFile =
              visibleOutfit.name
                  .replace('_lowpoly', `_v${selectedOutfitVariant}.jpg`)
                  .replace('_meta', '');
          outfitLoader.load(
              `/avatars/outfits/${outfitTextureFile}`,
              function(texture) {
                // @ts-ignore
                const outfitTexture = outfit.material.map;
                // @ts-ignore
                outfit.material.map = texture;
                // @ts-ignore
                outfit.material.needsUpdate = true;
                texture.encoding = sRGBEncoding;
                texture.flipY = false;
                texture.offset.copy(outfitTexture.offset);
                texture.repeat.copy(outfitTexture.repeat);
                texture.needsUpdate = true;
                outfitTexture.dispose();
                outfitVariantLoaded = true;
                if (bodyVisibilityMaskLoaded) {
                  model.visible = true;
                }
              },
          );
        }
        const outfitName = visibleOutfit.name.indexOf('_meta') > -1 ?
            visibleOutfit.name + '_body_visibility_mask.webp' :
            visibleOutfit.name.replace('_lowpoly', '_body_visibility_mask.png');
        loader.load(
            `/avatars/outfits/${outfitName}`,
            function(texture) {
              // @ts-ignore
              const skinTexture = mesh.material.map;
              // @ts-ignore
              if (mesh.material.alphaMap) {
                // @ts-ignore
                mesh.material.alphaMap.dispose();
              }
              // @ts-ignore
              mesh.material.alphaMap = texture;
              // @ts-ignore
              mesh.material.alphaTest = 0.2;
              texture.encoding = sRGBEncoding;
              texture.flipY = false;
              texture.offset.copy(skinTexture.offset);
              texture.repeat.copy(skinTexture.repeat);
              texture.needsUpdate = true;
              // @ts-ignore
              mesh.material.needsUpdate = true;
              bodyVisibilityMaskLoaded = true;
              if (outfitVariantLoaded) {
                model.visible = true;
              }
            },
        );

        const nloader = new TextureLoader();
        const normalMap = visibleOutfit.name.indexOf('_meta') > -1 ?
            visibleOutfit.name + '_normal_map.webp' :
            visibleOutfit.name.replace('_lowpoly', '_normal_map.jpg');
        nloader.load(
            `/avatars/outfits/${normalMap}`,
            function(texture) {
              // @ts-ignore
              const outfitTexture = outfit.material.map;
              // @ts-ignore
              if (outfit.material.normalMap) {
                // @ts-ignore
                outfit.material.normalMap.dispose();
              }
              // @ts-ignore
              outfit.material.normalMap = texture;
              // @ts-ignore
              outfit.material.needsUpdate = true;
              texture.encoding = sRGBEncoding;
              texture.flipY = false;
              texture.offset.copy(outfitTexture.offset);
              texture.repeat.copy(outfitTexture.repeat);
              texture.needsUpdate = true;
            },
        );
      }
    }


    // Cross-correlate the scene graph by relying on information in the
    // current scene graph; without this step, relationships between the
    // Three.js object graph and the glTF scene graph will be lost.
    clone[$correlatedSceneGraph] =
        CorrelatedSceneGraph.from(clone, this.correlatedSceneGraph);

    return clone;
  }

  /**
   * Creates a clone of the given material, and applies a patch to the
   * shader program.
   */
  [$cloneAndPatchMaterial](
      material: MeshStandardMaterial,
      sourceUUIDToClonedMaterial: Map<string, Material>) {
    // If we already cloned this material (determined by tracking the UUID of
    // source materials that have been cloned), then return that previously
    // cloned instance:
    if (sourceUUIDToClonedMaterial.has(material.uuid)) {
      return sourceUUIDToClonedMaterial.get(material.uuid)!;
    }

    const clone = material.clone() as MeshStandardMaterial;
    if (material.map != null) {
      clone.map = material.map.clone();
      clone.map.needsUpdate = true;
    }
    if (material.normalMap != null) {
      clone.normalMap = material.normalMap.clone();
      clone.normalMap.needsUpdate = true;
    }
    if (material.emissiveMap != null) {
      clone.emissiveMap = material.emissiveMap.clone();
      clone.emissiveMap.needsUpdate = true;
    }

    // Clones the roughnessMap if it exists.
    let roughnessMap: Texture|null = null;
    if (material.roughnessMap != null) {
      roughnessMap = material.roughnessMap.clone();
    }

    // Assigns the roughnessMap to the cloned material and generates mipmaps.
    if (roughnessMap != null) {
      roughnessMap.needsUpdate = true;
      clone.roughnessMap = roughnessMap;

      // Generates mipmaps from the clone of the roughnessMap.
      const {threeRenderer, roughnessMipmapper} = Renderer.singleton;
      // XR must be disabled while doing offscreen rendering or it will
      // clobber the camera.
      const {enabled} = threeRenderer.xr;
      threeRenderer.xr.enabled = false;
      roughnessMipmapper.generateMipmaps(clone as MeshStandardMaterial);
      threeRenderer.xr.enabled = enabled;
    }

    // Checks if roughnessMap and metalnessMap share the same texture and
    // either clones or assigns.
    if (material.roughnessMap === material.metalnessMap) {
      clone.metalnessMap = roughnessMap;
    } else if (material.metalnessMap != null) {
      clone.metalnessMap = material.metalnessMap.clone();
      clone.metalnessMap.needsUpdate = true;
    }

    // Checks if roughnessMap and aoMap share the same texture and
    // either clones or assigns.
    if (material.roughnessMap === material.aoMap) {
      clone.aoMap = roughnessMap;
    } else if (material.aoMap != null) {
      clone.aoMap = material.aoMap.clone();
      clone.aoMap.needsUpdate = true;
    }

    // This allows us to patch three's materials, on top of patches already
    // made, for instance GLTFLoader patches SpecularGlossiness materials.
    // Unfortunately, three's program cache differentiates SpecGloss materials
    // via onBeforeCompile.toString(), so these two functions do the same
    // thing but look different in order to force a proper recompile.
    const oldOnBeforeCompile = material.onBeforeCompile;
    clone.onBeforeCompile = (material as any).isGLTFSpecularGlossinessMaterial ?
        (shader: Shader) => {
          oldOnBeforeCompile(shader, undefined as any);
          shader.fragmentShader = shader.fragmentShader.replace(
              '#include <alphatest_fragment>', alphaChunk);
        } :
        (shader: Shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
              '#include <alphatest_fragment>', alphaChunk);
          oldOnBeforeCompile(shader, undefined as any);
        };
    // This makes shadows better for non-manifold meshes
    clone.shadowSide = FrontSide;
    // This improves transparent rendering and can be removed whenever
    // https://github.com/mrdoob/three.js/pull/18235 finally lands.
    if (clone.transparent) {
      clone.depthWrite = false;
    }
    // This little hack ignores alpha for opaque materials, in order to comply
    // with the glTF spec.
    if (!clone.alphaTest && !clone.transparent) {
      clone.alphaTest = -0.5;
    }

    sourceUUIDToClonedMaterial.set(material.uuid, clone);

    return clone;
  }
}
