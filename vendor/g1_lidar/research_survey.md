# Unitree G1 LiDAR・カメラを用いた研究調査レポート

**調査日:** 2026-04-06  
**キーワード:** VLA, VLM, セマンティック, SLAM

---

## 1. Unitree G1 センサ構成

| センサ | 型番 | 主要スペック |
|--------|------|-------------|
| **3D LiDAR** | Livox MID-360 | 360°×(-7°~52°) FOV, 200,000 pts/s, 40m検出距離(10%反射率), IP67 |
| **深度カメラ** | Intel RealSense D435i | 1280×720@30fps, 86°×57° FOV, IMU内蔵, アクティブステレオ |
| **RGBカメラ** | 頭部搭載 | シーン認識・物体検出用 |

> **注意:** Livox MID-360は逆さまに搭載されており、ソフトウェア側で点群データの座標変換が必要。

---

## 2. SLAM関連研究

### 2.1 G1上のSLAM実装 (sentdex / GeekTak, 2025)

- **KISS ICP** (Keep It Simple, Stupid ICP) を用いた点群レジストレーション・オドメトリ推定
- **Open3D** による3Dデータ処理・可視化
- Voxel Hash Mapによる効率的な環境表現
- Occupancy Gridベースの障害物認識・経路計画
- ROS非依存のPythonベース実装を志向
- 参考: https://www.geektak.com/blog/unitree-g1-software-slam-navigation-and

### 2.2 OM1 ROS2 SDK (OpenMind, v1.0.1 / 2026年3月)

- RPLiDAR + SLAM Toolbox + Nav2スタックによる自律ナビゲーション
- リアルタイムSLAMと経路計画をROS2上で統合
- GitHub: https://github.com/OpenMind/OM1-ros2-sdk

### 2.3 セマンティックSLAM関連 (G1直接ではないが応用可能)

| 手法 | 概要 | 特徴 |
|------|------|------|
| **vS-Graphs** (2025) | Visual SLAMと3Dシーングラフの統合 | 階層的シーン理解（部屋・フロア推定）、LiDARベース並の精度を視覚のみで達成 |
| **OGScene3D** (2026) | インクリメンタルなOpen-Vocabulary 3Dシーン理解 | Gaussianセマンティック表現、逐次的にグローバル整合性のあるセマンティックマップ構築 |
| **ConceptGraphs** | RGB-DシーケンスからOpen-Vocabulary 3Dシーングラフ構築 | 2D Foundation Model→3D融合、空間的・意味的推論を統合 |
| **SG-SLAM** | セマンティックグラフを活用したLiDAR SLAM | 幾何・意味・トポロジ特徴の統合、リアルタイム性能 |

---

## 3. VLA (Vision-Language-Action) 研究

### 3.1 UnifoLM-VLA-0 (Unitree公式, 2026年1月)

**G1ヒューマノイドロボットの汎用マニピュレーション向けVLAモデル**

- **ベースモデル:** Qwen2.5-VL-7B
- **学習データ:** 約340時間の実ロボットデータ
- **主要技術:**
  - 空間セマンティック強化 — テキスト指示と2D/3D空間情報の深い融合
  - Action Chunking予測、順逆動力学制約
  - 階層的タスク分解、3D物体検出、軌道予測
- **性能:** 12カテゴリの複雑なマニピュレーションタスクを単一ポリシーで実行可能
  - LIBERO シミュレーションベンチマークで平均98.7%の精度
  - タスク例: ブロック積み、バッグ挿入、ボード消去、テーブル清掃、薬注ぎ等
- **リソース:**
  - GitHub: https://github.com/unitreerobotics/unifolm-vla
  - HuggingFace: https://huggingface.co/unitreerobotics/UnifoLM-VLA-Base
  - Project: https://unigen-x.github.io/unifolm-vla.github.io/

### 3.2 NaVILA (UCSD/USC/NVIDIA, RSS 2025)

**脚式ロボットナビゲーション向け2階層VLAフレームワーク**

- **アーキテクチャ:**
  - 上位層: VLAモデルが中間レベルの空間コマンドを自然言語で生成（例: "forward 75cm"）
  - 下位層: 視覚ベースの歩行RLポリシーがコマンドを実行
- **特徴:**
  - LiDARインタラクションで訓練した視覚ベース歩行ポリシー（Sim-to-Realギャップ低減）
  - 長期ナビゲーション、狭い通路、不整地に対応
  - YouTube動画等の実世界人間データで学習
- **検証プラットフォーム:** Unitree Go2, Booster T1, **Unitree G1**
- **ベンチマーク:** VLN-CE-Isaac（IsaacLabベースの物理リアリスティックベンチマーク）を新規提案
- 参考: https://navila-bot.github.io/

### 3.3 Isaac Lab上のG1 VLAシステム

#### 階層型VLM-ULC (mturan33, 2025-2026)
- Florence-2 VLMが~1Hzで3Dターゲットを生成 → triple actor-criticポリシーが50Hzで実行
- 逐次カリキュラム学習: 全方向歩行→アーム到達→把持→スキルチェーン
- アーム到達: 86.9%到達率、平均3.08cm誤差

#### Long-Horizon Pick-and-Place (mturan33, 2025-2026)
- 8つのRLスキルプリミティブのルールベース状態機械
- 約100秒で完全タスク完了（転倒ゼロ）

#### Isaac GR00T N1.6 (NVIDIA, 2026)
- マルチモーダルVLAモデル（Cosmos-Reason-2B知覚）
- 多様なG1データセットで訓練されたロコマニピュレーション
- ワールドモデルと分解型アクション計画

---

## 4. VLM (Vision-Language Model) 研究

### 4.1 VLM Edge Deployment (University of Leeds, 2026年1月)

**G1上でのリアルタイムVLM推論のエッジ展開** (arXiv:2601.14921)

- **課題:** VLMのレイテンシ・オンボードリソース制限・クラウドオフロードのプライバシーリスク
- **ソリューション:** WebRTCベースパイプライン → ORAN/MECエッジノード（NVIDIA L4 GPU）
- **評価モデル:**
  - LLaMA-3.2-11B-Vision-Instruct: クラウド並の精度、レイテンシ5%削減
  - Qwen2-VL-2B-Instruct: サブ秒応答、レイテンシ半減以上（精度トレードオフあり）
- **意義:** ロボットのリアルタイムマルチモーダル知覚をエッジで実現する実用的アーキテクチャ

### 4.2 SysNav (2026年3月)

**3階層オブジェクトナビゲーションシステム** (arXiv:2603.06914)

- **アーキテクチャ:**
  - High-level: VLMによるセマンティック環境表現・ナビゲーションガイダンス
  - Mid-level: 部屋ベース階層ナビゲーション戦略（VLM推論は部屋レベルの判断時のみ）
  - Low-level: 身体固有のモーション制御
- **検証:** 車輪ロボット、Unitree Go2、**Unitree G1** の3プラットフォームで190件の実世界実験
- **成果:** 建物規模の長距離オブジェクトナビゲーションを実環境で初めて信頼性高く達成
- 4つのシミュレーションベンチマークでSOTA

### 4.3 FSR-VLN (Horizon Robotics, 2025)

**Fast-and-Slow Reasoning による Vision-Language Navigation**

- **階層的マルチモーダルシーングラフ (HMSG):**
  - 粗い部屋レベル → 細かいビュー・物体レベルの段階的検索
- **Fast-to-Slow推論:**
  - Fast: 高速マッチングで候補選択
  - Slow: VLMベースの精緻化（高速直感が失敗した場合のみ）
  - VLMベース手法比で応答時間82%削減
- **性能:** G1データセットで92%成功率（80/87指示）
  - MobilityVLA(34.5%)、OK-Robot(60.9%)を大幅に上回る
- **G1統合:** 音声インタラクション・計画・制御モジュールと統合
- Project: https://horizonrobotics.github.io/robot_lab/fsr-vln/

---

## 5. セマンティック技術の統合トレンド

### 5.1 LiDAR + カメラ + VLM融合の方向性

```
┌─────────────────────────────────────────────────────────────┐
│                    High-Level (VLM/VLA)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ 自然言語理解  │  │ セマンティック│  │ タスク計画・推論  │  │
│  │ (指示解釈)    │  │ シーン理解    │  │ (長期行動計画)    │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                    Mid-Level (Semantic SLAM)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ 3Dシーン      │  │ セマンティック│  │ Open-Vocabulary   │  │
│  │ グラフ構築    │  │ マップ        │  │ 物体認識          │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                    Low-Level (Sensor Fusion)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ LiDAR SLAM    │  │ RGB-D処理     │  │ 点群-画像融合     │  │
│  │ (KISS ICP)    │  │ (RealSense)   │  │ (位置合わせ)      │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 研究の成熟度マッピング

| 領域 | G1での実証 | 成熟度 | 代表的研究 |
|------|-----------|--------|-----------|
| LiDAR SLAM | ✅ 実機検証済 | ★★★★☆ | KISS ICP, OM1 SDK |
| VLAマニピュレーション | ✅ 実機検証済 | ★★★★☆ | UnifoLM-VLA-0 |
| VLAナビゲーション | ✅ 実機検証済 | ★★★☆☆ | NaVILA, SysNav |
| VLMエッジ推論 | ✅ 実機検証済 | ★★★☆☆ | Edge VLM (Leeds) |
| VLMナビゲーション | ✅ 実機検証済 | ★★★★☆ | FSR-VLN |
| セマンティックSLAM | ⚠️ 間接的 | ★★☆☆☆ | ConceptGraphs, vS-Graphs |
| LiDAR+Camera+VLM統合 | ⚠️ 部分的 | ★★☆☆☆ | SysNav (部分統合) |
| セマンティックシーングラフ | ⚠️ 間接的 | ★★★☆☆ | FSR-VLN (HMSG) |

---

## 6. 今後の研究機会（未開拓領域）

### 6.1 LiDAR点群 + VLMによるセマンティックSLAM
- G1のLivox MID-360点群をVLMで意味付けし、Open-Vocabularyセマンティックマップを構築
- ConceptGraphsやOGScene3Dのアプローチを3D LiDAR点群に拡張
- **現状:** RGB-Dベースのセマンティックマップは多いが、LiDAR点群との深い統合は未成熟

### 6.2 VLA + セマンティックSLAMの統合ナビゲーション
- UnifoLM-VLAの空間セマンティック理解 + LiDAR SLAMの幾何精度を統合
- セマンティックマップ上でのVLAベースタスク計画
- **現状:** SysNavが部分的に実現しているが、LiDAR情報の活用が限定的

### 6.3 リアルタイムエッジVLM + SLAM閉ループ
- エッジVLM推論（Leeds研究）をSLAMループに組み込み
- LiDARスキャンに対するリアルタイムセマンティックアノテーション
- **現状:** VLMとSLAMは別々のパイプラインで動作しており、閉ループ統合は未実現

---

## 7. 主要論文・リソース一覧

| # | タイトル | 年 | キーワード | リンク |
|---|---------|-----|-----------|--------|
| 1 | UnifoLM-VLA-0 | 2026/01 | VLA, セマンティック | [GitHub](https://github.com/unitreerobotics/unifolm-vla) |
| 2 | NaVILA (RSS 2025) | 2024/12 | VLA, ナビゲーション | [arXiv:2412.04453](https://arxiv.org/abs/2412.04453) |
| 3 | SysNav | 2026/03 | VLM, ナビゲーション | [arXiv:2603.06914](https://arxiv.org/abs/2603.06914) |
| 4 | FSR-VLN | 2025/09 | VLM, セマンティック | [Project](https://horizonrobotics.github.io/robot_lab/fsr-vln/) |
| 5 | VLM on Edge (G1) | 2026/01 | VLM, エッジ推論 | [arXiv:2601.14921](https://arxiv.org/abs/2601.14921) |
| 6 | Isaac G1 VLM-ULC | 2025-26 | VLM, RL, マニピュレーション | [GitHub](https://github.com/mturan33/isaac-g1-ulc-vlm) |
| 7 | Isaac GR00T N1.6 | 2026 | VLA, ワールドモデル | [NVIDIA Blog](https://developer.nvidia.com/blog/building-generalist-humanoid-capabilities-with-nvidia-isaac-gr00t-n1-6-using-a-sim-to-real-workflow/) |
| 8 | ConceptGraphs | 2023 | セマンティック, シーングラフ | [Project](http://concept-graphs.github.io/) |
| 9 | vS-Graphs | 2025/03 | セマンティックSLAM | [arXiv:2503.01783](https://arxiv.org/abs/2503.01783) |
| 10 | OGScene3D | 2026/03 | セマンティック, 3Dシーン | [arXiv:2603.16301](https://arxiv.org/abs/2603.16301) |
| 11 | OM1 ROS2 SDK | 2026/03 | SLAM, Nav2 | [GitHub](https://github.com/OpenMind/OM1-ros2-sdk) |
| 12 | KISS ICP on G1 | 2025 | SLAM, 点群 | [GeekTak](https://www.geektak.com/blog/unitree-g1-software-slam-navigation-and) |
