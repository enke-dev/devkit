# DevKit

# [0.4.0](https://github.com/enke-dev/devkit/compare/v0.3.1...v0.4.0) (2026-09-21)

### Bug Fixes

* clear stand-in cursors at the window edge ([c85d605](https://github.com/enke-dev/devkit/commit/c85d605539d3878a75a7b713b23646431685f152))
* draw one line per edge, not two ([5a8b554](https://github.com/enke-dev/devkit/commit/5a8b55473c22d1d4c954f21c443ebaddfde8fe09))
* follow the picker in the tree ([3a7bba6](https://github.com/enke-dev/devkit/commit/3a7bba693e83df66c3d3176c443ad89992a9d3f3))
* hide the checkerboard behind a rendered frame ([b6747ee](https://github.com/enke-dev/devkit/commit/b6747ee1e1ec9e92e9e35f7f482525937034f063))
* inset macos app icon to apple grid ([8124a5f](https://github.com/enke-dev/devkit/commit/8124a5fda6d1318d1adf7eea5d8c71362f2a657e))
* interpolate the detach tooltip ([10513bc](https://github.com/enke-dev/devkit/commit/10513bc36b2ac911d92f71417893013f15f9d264))
* keep a pick that beats the tree it opens ([1cc38a2](https://github.com/enke-dev/devkit/commit/1cc38a27af5dc1c6950cb628f43bab95eb1d3ff6))
* let go of the page's cursor on the way out ([377282a](https://github.com/enke-dev/devkit/commit/377282a55ffb21e51ac9173170b85a15b4836f4c))
* let go of the selection when the drawer closes ([97f7103](https://github.com/enke-dev/devkit/commit/97f71031cba8594d808f241f1853ed3b93a66352))
* make the inspector divider a single line ([9e50c94](https://github.com/enke-dev/devkit/commit/9e50c943935409f0c3b58d1ac6f38d873a92c619))
* make the inspector tabs read as tabs ([707d5f2](https://github.com/enke-dev/devkit/commit/707d5f2e7beb57e2c14e5a93adf9ff2f84022b4e))
* measure the pane header against its own host ([5cc6a83](https://github.com/enke-dev/devkit/commit/5cc6a83fa0c9cbd1e581571d65ec78e2eee7c530))
* one header breakpoint, honest pane size ([52b2ef9](https://github.com/enke-dev/devkit/commit/52b2ef9ee70c4e9018d00d1b58b3a71aabd1486f))
* one inset for every panel edge ([5f06d0a](https://github.com/enke-dev/devkit/commit/5f06d0a22caf51c0024d7c3a1858f6e7e1e6e87b))
* query the pane container without naming it ([ec672ed](https://github.com/enke-dev/devkit/commit/ec672edbb1389003d5764bb2304e0ab676b26826))
* scroll to the revealed row, and stop blanking the tree ([545ceb4](https://github.com/enke-dev/devkit/commit/545ceb427e3569f00d59418788ac689db6f3d758))
* share one grid across console entries ([4fa7544](https://github.com/enke-dev/devkit/commit/4fa75447a69d4926fc9e58ecad2563a5363c3f23))
* tighten header spacing when it narrows ([8f57aa9](https://github.com/enke-dev/devkit/commit/8f57aa9208b0920c10d12c5a6ec0ec42d221ec9e))
* use a terminal icon for the inspector toggle ([6bfd1ee](https://github.com/enke-dev/devkit/commit/6bfd1ee11077df96fd257d8913853cdf6e1ccb9a))

### Features

* add introspection protocol ([79c111e](https://github.com/enke-dev/devkit/commit/79c111e95bf726b36fdeb57d61e453d8370a4518))
* add introspection to the sidecar ([227e35e](https://github.com/enke-dev/devkit/commit/227e35e26be42d36e98948e4a9305a3a1df97ecc))
* add the element inspector ([c753767](https://github.com/enke-dev/devkit/commit/c7537674c87d4af45e18d32e7c3cd989a8c11c54))
* address DOM nodes by handle ([e86f731](https://github.com/enke-dev/devkit/commit/e86f7314cf7292df1601df2b69af99dd655d84c0))
* dock or detach the inspector ([2d59338](https://github.com/enke-dev/devkit/commit/2d593387e88e10c64fef26116189b4fa7db580c7))
* filter the console by level and engine from a menu ([25a2441](https://github.com/enke-dev/devkit/commit/25a24419d7bd25f93378b142ae27d0ab9978d517))
* keep the selection when switching tree engine ([6223ffb](https://github.com/enke-dev/devkit/commit/6223ffb4309cff73ac193182dfbf11a78bbc2760))
* resize the attached inspector ([1d46cd2](https://github.com/enke-dev/devkit/commit/1d46cd26ea6abcb4b9ec5c13af7ab496a506b6b4))
* show the DOM as a tree ([19dc455](https://github.com/enke-dev/devkit/commit/19dc455071539dd486ceed52d8e86c1dd987d897))
* show when and where a console line came from ([9210793](https://github.com/enke-dev/devkit/commit/9210793e62f5db929eca0ba9aa991d700132b1af))
* shrink the pane header on narrow panes ([a3d5047](https://github.com/enke-dev/devkit/commit/a3d50477e951aff1f9ce9eab2755c4fc32fa7d84))

## [0.3.1](https://github.com/enke-dev/devkit/compare/v0.3.0...v0.3.1) (2026-09-18)

### Bug Fixes

* ship the sidecar entry where the app looks for it ([f842d5a](https://github.com/enke-dev/devkit/commit/f842d5a2453b7182eda73f27908d8a10ceab77d5))

# [0.3.0](https://github.com/enke-dev/devkit/compare/v0.2.0...v0.3.0) (2026-09-18)

### Bug Fixes

* keep fps readout steady once a pane settles ([f136743](https://github.com/enke-dev/devkit/commit/f13674371665d7520f47bc123b9420a547000704))

### Features

* open a pane's page in a headed window ([1f54426](https://github.com/enke-dev/devkit/commit/1f54426291f462d4d06d871e39977ce0884315a3))
* per-pane colour scheme ([73655df](https://github.com/enke-dev/devkit/commit/73655dfa39037ffe957b9c520affa18c355b0da5))

# [0.2.0](https://github.com/enke-dev/devkit/compare/v0.1.1...v0.2.0) (2026-09-18)

### Features

* ask for a newer DevKit from the menu ([7faa482](https://github.com/enke-dev/devkit/commit/7faa48258810cc7ad60199985f9fabb45d27b12f))

## [0.1.1](https://github.com/enke-dev/devkit/compare/v0.1.0...v0.1.1) (2026-09-18)

### Bug Fixes

* **ci:** build the Intel app on a runner that exists ([4dd64cf](https://github.com/enke-dev/devkit/commit/4dd64cfb53642a504c70960ee759226eb3346ee0))

# 0.1.0 (2026-09-18)

### Features

* **app:** the window itself ([ada9021](https://github.com/enke-dev/devkit/commit/ada9021c5a58a59eb4df87aaa6f1d8d1b6db7288))
* give DevKit its icon ([cd0906f](https://github.com/enke-dev/devkit/commit/cd0906fe554a09dbe0e00480cae6a1074ea0ae9d))
* host the window and carry the frames ([6f20990](https://github.com/enke-dev/devkit/commit/6f20990bb01f11e2fed63289bab6cea478bfcd2b))
* **protocol:** say what the two ends may tell each other ([b32754e](https://github.com/enke-dev/devkit/commit/b32754ec2610b4e60eae59658f616b0e2c35d7a6))
* **sidecar:** drive three engines and capture what they draw ([e137e4c](https://github.com/enke-dev/devkit/commit/e137e4cd7328ef5995f2777aa48b77abadf3897e))
