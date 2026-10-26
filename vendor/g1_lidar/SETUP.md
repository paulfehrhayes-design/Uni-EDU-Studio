# Unitree G1 LiDAR 点群可視化 セットアップガイド

## ディレクトリ構成

```
g1_lidar/
├── Livox-SDK2/              # Livox LiDAR基盤SDK (ビルド済み)
├── livox_ros_driver2/       # Livox MID-360 ROS2ドライバ
├── FAST_LIO_LOCALIZATION_HUMANOID/  # G1対応SLAM (要追加セットアップ)
├── ros2_ws/                 # ROS2ワークスペース (ビルド済み)
│   ├── src/
│   │   ├── livox_ros_driver2 -> シンボリックリンク
│   │   └── FAST_LIO -> シンボリックリンク
│   └── install/             # ビルド成果物
├── config/
│   └── MID360_G1_config.json  # G1用LiDAR設定
├── glim_config/             # GLIM設定ファイル (G1カスタマイズ済み)
│   ├── config_ros.json        # トピック・IMUスケール設定
│   └── config_sensors.json    # センサキャリブレーション
├── fast_livo2_config/       # Fast-LIVO2設定ファイル
│   ├── mid360_d435i_g1.yaml   # LiDAR/IMU/カメラ統合パラメータ
│   └── camera_d435i_g1.yaml   # D435iカメラ内部パラメータ
├── docker/                  # Docker関連ファイル
│   ├── Dockerfile.fast_livo2  # Fast-LIVO2ビルド環境
│   └── docker-compose.yml     # GLIM/Fast-LIVO2統合管理
├── launch/
│   ├── g1_lidar_viz.launch.py      # 点群可視化用
│   ├── g1_mapping.launch.py        # FAST-LIO マッピング用
│   ├── g1_glim.launch.py           # GLIM マッピング用
│   └── g1_fast_livo2.launch.py     # Fast-LIVO2 マッピング用
├── scripts/
│   ├── setup_glim_config.bash # GLIM設定ファイルのダウンロード
│   ├── run_glim.bash          # GLIM Docker起動
│   ├── run_fast_livo2.bash    # Fast-LIVO2 Docker起動
│   └── save_map.py            # G1内蔵SLAM地図保存
├── rviz/
│   └── pointcloud_view.rviz   # RViz2設定
├── setup_env.bash           # 環境セットアップスクリプト
└── research_survey.md       # 調査レポート
```

## ビルド済みコンポーネント

| コンポーネント | 状態 | 備考 |
|:---|:---|:---|
| Livox-SDK2 | ✅ ビルド済み | GCC13対応パッチ適用 (`<cstdint>` 追加) |
| livox_ros_driver2 | ✅ ビルド済み | ROS2 Jazzy対応、SDK2パス修正済み |
| FAST_LIO | ✅ ビルド済み | `ros-jazzy-pcl-ros` インストール済み |
| open3d_loc | ✅ ビルド済み | Open3D 0.18.0 C++ (プリコンパイル版) |

## G1内蔵SLAMとの連携

G1はLiDARドライバとSLAMを内蔵で動かしており、外部ドライバとの競合が発生します。
以下のトピックがG1から直接受信可能です：

| トピック | 型 | 内容 |
|:---|:---|:---|
| `/cloud_registered_1` | PointCloud2 | SLAM処理済み点群（位置合わせ済み） |
| `/Odometry_loc` | Odometry | SLAM推定位置 |
| `/dog_imu_raw` | IMU | 生IMUデータ |

※ `/utlidar/*` トピックはDDS互換性の問題で直接受信不可

## 使い方

### 1. 環境のロード

```bash
source ~/workspace/sakai/g1_lidar/setup_env.bash
```

### 2. 点群の可視化（G1接続時）

```bash
# LiDARドライバ + RViz2 起動
ros2 launch ~/workspace/sakai/g1_lidar/launch/g1_lidar_viz.launch.py

# RVizなし（ドライバのみ）
ros2 launch ~/workspace/sakai/g1_lidar/launch/g1_lidar_viz.launch.py rviz:=false

# カスタム設定ファイルを使用
ros2 launch ~/workspace/sakai/g1_lidar/launch/g1_lidar_viz.launch.py \
    config:=/path/to/your/config.json
```

### 3. トピック確認

```bash
# 利用可能なトピック一覧
ros2 topic list

# 点群データの確認
ros2 topic echo /livox/lidar --no-arr

# 周波数確認
ros2 topic hz /livox/lidar
```

## ネットワーク設定（G1接続前に必要）

G1のLiDAR (Livox MID-360) は `192.168.123.120` に接続されています。
PCのネットワークインターフェースを以下のように設定してください：

```bash
# PCのIPを 192.168.123.2 に設定（インターフェース名は環境に合わせて変更）
sudo ip addr add 192.168.123.2/24 dev eth0

# 接続確認
ping 192.168.123.120
```

設定ファイル `config/MID360_G1_config.json` の `host_net_info` 内のIPが
PCのIPアドレスと一致していることを確認してください。

## G1 LiDAR の注意事項

- **逆さま搭載**: Livox MID-360はG1上で逆さまに搭載されています
  - 設定ファイルで `roll: 180.0` を指定することで座標系を補正済み
  - IMUデータも補正が必要な場合は FAST_LIO_LOCALIZATION_HUMANOID の
    修正版 livox_ros_driver2 を使用してください

## FAST_LIO ビルド手順（SLAM使用時）

`ros-jazzy-pcl-ros` をインストール後：

```bash
sudo apt install ros-jazzy-pcl-ros

source ~/workspace/sakai/g1_lidar/setup_env.bash
cd ~/workspace/sakai/g1_lidar/ros2_ws
colcon build --packages-select fast_lio \
    --cmake-args -DCMAKE_POLICY_VERSION_MINIMUM=3.5
```

## open3d_loc ビルド手順（ローカリゼーション使用時）

Open3D C++ライブラリ (v0.14.1推奨) をインストール後：

```bash
# open3d_loc/CMakeLists.txt の Open3D_DIR を修正
# set(Open3D_DIR "/path/to/open3d141/lib/cmake/Open3D")

cd ~/workspace/sakai/g1_lidar/ros2_ws/src
ln -s ~/workspace/sakai/g1_lidar/FAST_LIO_LOCALIZATION_HUMANOID/open3d_loc .
cd ~/workspace/sakai/g1_lidar/ros2_ws
colcon build --packages-select open3d_loc
```

## GLIM マッピング（GPU加速 LiDAR SLAM）

GLIM は GPU 加速による高精度な LiDAR SLAM フレームワーク。
ループクロージャ検出、インタラクティブ地図修正に対応。

### セットアップ

```bash
# 1. GLIM デフォルト設定ファイルをダウンロード
bash ~/workspace/sakai/g1_lidar/scripts/setup_glim_config.bash

# 2. (オプション) GLIM Docker イメージを事前取得
docker pull koide3/glim_ros2:jazzy          # CPU版
docker pull koide3/glim_ros2:jazzy_cuda13.1 # GPU/CUDA版
```

### 実行方法

```bash
# ターミナル1: LiDAR ドライバ + RViz2 起動
source ~/workspace/sakai/g1_lidar/setup_env.bash
ros2 launch ~/workspace/sakai/g1_lidar/launch/g1_glim.launch.py

# ターミナル2: GLIM 起動 (Docker)
bash ~/workspace/sakai/g1_lidar/scripts/run_glim.bash      # CPU
bash ~/workspace/sakai/g1_lidar/scripts/run_glim.bash gpu   # GPU/CUDA
bash ~/workspace/sakai/g1_lidar/scripts/run_glim.bash ppa   # ネイティブ (PPA)
```

### ネイティブインストール（Docker不要）

```bash
curl -s https://koide3.github.io/ppa/setup_ppa.sh | sudo bash
sudo apt install ros-jazzy-glim-ros
```

### docker-compose での起動

```bash
cd ~/workspace/sakai/g1_lidar/docker
docker compose --profile glim up       # CPU
docker compose --profile glim-gpu up   # GPU
```

### 設定のカスタマイズ

- `glim_config/config_ros.json`: トピック名、IMU加速度スケール（9.80665）
- `glim_config/config_sensors.json`: LiDAR-IMU 外部キャリブレーション (`T_lidar_imu`)

## Fast-LIVO2 マッピング（LiDAR-Inertial-Visual SLAM）

Fast-LIVO2 は LiDAR + IMU + カメラの3センサ融合による高精度SLAMフレームワーク。
G1 の RealSense D435i カメラを活用してテクスチャ付き3Dマップを構築。

### セットアップ

```bash
# 1. Docker イメージをビルド（初回のみ、約10-20分）
bash ~/workspace/sakai/g1_lidar/scripts/run_fast_livo2.bash build
# または
cd ~/workspace/sakai/g1_lidar/docker
docker compose build fast-livo2

# 2. (オプション) RealSense カメラドライバをインストール
sudo apt install ros-jazzy-realsense2-camera
```

### 実行方法

```bash
# ターミナル1: LiDAR ドライバ + カメラ + RViz2 起動
source ~/workspace/sakai/g1_lidar/setup_env.bash
ros2 launch ~/workspace/sakai/g1_lidar/launch/g1_fast_livo2.launch.py

# ターミナル2: Fast-LIVO2 起動 (Docker)
bash ~/workspace/sakai/g1_lidar/scripts/run_fast_livo2.bash
```

### docker-compose での起動

```bash
cd ~/workspace/sakai/g1_lidar/docker
docker compose --profile fast-livo2 up
```

### 設定のカスタマイズ

- `fast_livo2_config/mid360_d435i_g1.yaml`: LiDAR/IMU/カメラトピック、外部キャリブレーション
- `fast_livo2_config/camera_d435i_g1.yaml`: D435i カメラ内部パラメータ

### キャリブレーション

LiDAR-カメラ間の外部キャリブレーションには [FAST-Calib](https://github.com/hku-mars/FAST-Calib) を使用：

```bash
# キャリブレーション結果を以下に設定
# fast_livo2_config/mid360_d435i_g1.yaml の Rcl, Pcl パラメータ
```

## SLAMフレームワーク比較

| 項目 | FAST-LIO | GLIM | Fast-LIVO2 |
|:---|:---|:---|:---|
| センサ | LiDAR + IMU | LiDAR + IMU | LiDAR + IMU + カメラ |
| GPU加速 | なし | あり (CUDA) | なし |
| ループクロージャ | なし | あり | なし |
| テクスチャマップ | なし | なし | あり |
| ROS2対応 | Jazzy | Jazzy (Docker/PPA) | Humble (Docker) |
| 導入難易度 | 低 | 低 (Docker) | 中 (Docker ビルド必要) |

## トラブルシューティング

### 点群が表示されない
1. ネットワーク接続を確認: `ping 192.168.123.120`
2. RViz2の Fixed Frame が `livox_frame` になっているか確認
3. トピック名を確認: `ros2 topic list | grep livox`
4. ファイアウォールを確認: UDP 56300番ポートが開いているか

### ライブラリが見つからない
```bash
# Livox SDK2のライブラリパスを設定
export LD_LIBRARY_PATH=~/workspace/sakai/g1_lidar/Livox-SDK2/build/sdk_core:$LD_LIBRARY_PATH
```

### Docker コンテナ内から ROS2 トピックが見えない
FastDDS の Shared Memory Transport がホスト-コンテナ間で動作しない場合があります。
`docker/fastdds_no_shm.xml` を使って SHM を無効化してください（`run_glim.bash` / `docker-compose.yml` では設定済み）。

```bash
# 手動で Docker を実行する場合
docker run --rm --net=host --ipc=host \
  -e FASTRTPS_DEFAULT_PROFILES_FILE=/config/fastdds_no_shm.xml \
  -v $(pwd)/docker/fastdds_no_shm.xml:/config/fastdds_no_shm.xml:ro \
  ...
```

### GLIM が "failed to open libodometry_estimation_gpu.so" で終了する
`glim_config/config.json` の `config_odometry` が `config_odometry_gpu.json` になっています。
CPU版のDockerイメージを使う場合は `config_odometry_cpu.json` に変更してください。
