// 内蔵サンプル（架空の住宅）。Blender アドオンの「サンプル建物を生成」と同じモデル。
import modelURL from '../sample/model.glb?inline';
import manifest from '../sample/manifest.json';
import { dataURLtoBlob } from './io.js';

export async function loadSampleData() {
  const glb = await dataURLtoBlob(modelURL).arrayBuffer();
  return { manifest: structuredClone(manifest), glb, project: null };
}

// 初回に用意する見本シート。api.anchor(部材名, [Blender座標]) で部材に固定した点を作る
export function sampleSheets(api) {
  const s1 = api.sheetFromCamera('CAM_01_SE', '01 南東外観');
  s1.camera.twoPoint = true;
  s1.camera.shift = 0.12;
  s1.camera.target[1] = s1.camera.position[1];
  s1.annotations = [
    api.text(16, 16, '南東からの外観', 20, 'bold'),
    api.text(16, 26, '前面道路から見上げる、東へ 3m 跳ね出した 2 階ボリューム', 9),
    api.leader('SLAB_2F', [8.2, -4.0, 3.45], 'キャンチレバー部\n下部を半屋外のピロティとして開放', -38, -22),
    api.leader('WIN_1F_S', [-3.0, -4.0, 1.6], '南面ガラスカーテンウォール\n庭とリビングを連続させる', -30, 26),
    api.leader('WALL_2F_S', [5.0, -3.5, 6.15], '外壁：木製羽目板張り', 22, -18),
    api.dim('SLAB_2F', [6.0, -4.0, 3.3], 'SLAB_2F', [9.0, -4.0, 3.3], -7, 'キャンチレバー '),
  ];

  const s2 = api.sheetFromCamera('CAM_02_Aerial', '02 鳥瞰・配置');
  s2.style = 'material';
  s2.annotations = [
    api.text(16, 16, '鳥瞰・配置構成', 20, 'bold'),
    api.text(16, 26, '道路からのアプローチと 2 階テラス', 9),
    api.arrow('LAND_Approach', [-8.75, -9.0, 0.03], 'LAND_Approach', [-6.4, 0.0, 0.03], 'アプローチ', true),
    api.leader('SLAB_2F', [-4.0, 0.0, 3.6], '2階 屋上テラス', -26, -20),
    api.leader('LAND_Deck', [2.0, -5.5, 0.25], '南側ウッドデッキ', 24, 18),
  ];

  const s3 = api.sheetFromCamera('CAM_03_Plan', '03 1階平面（FL+1,500 で切断）');
  s3.style = 'line';
  s3.shadows = false;
  s3.lineMM = 0.18;
  s3.section = { enabled: true, axis: 'z', value: 1.8, flip: false };
  api.setScale(s3, 100);
  s3.annotations = [
    api.text(16, 16, '1階平面図', 20, 'bold'),
    api.text(16, 26, '床上 1,500 で水平切断（モデルから生成）', 9),
    api.dim('SLAB_1F', [-6.0, -4.0, 0.3], 'SLAB_1F', [6.0, -4.0, 0.3], -10),
    api.dim('SLAB_1F', [6.0, -4.0, 0.3], 'SLAB_1F', [6.0, 4.0, 0.3], -10),
    api.leader('SLAB_1F', [-2.5, -1.5, 0.3], 'リビング・ダイニング', 10, -8),
    api.leader('STAIR_1F_2F', [0.5, 3.3, 1.74], '階段', 6, 30),
    api.leader('SLAB_1F', [5.2, 1.5, 0.3], '水回り', 12, -12),
  ];
  return [s1, s2, s3];
}
