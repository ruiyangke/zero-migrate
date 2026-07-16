{
  description = "zero-migrate: portable database migrations (Rust core + JS packages)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, rust-overlay, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };

        # The exact toolchain pinned in rust-toolchain.toml (channel + components +
        # cross targets). One source of truth for the shell and CI.
        rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
      in
      {
        devShells.default = pkgs.mkShell {
          # nativeBuildInputs run on the build host (compilers, tools). buildInputs
          # are libraries the build links against (found via pkg-config).
          nativeBuildInputs = [
            rustToolchain
            pkgs.pkg-config
            pkgs.nodejs_22
            pkgs.pnpm_10 # pin the 10.x line to match pnpm-lock.yaml (lockfileVersion 9.0)
          ];
          buildInputs = [
            pkgs.openssl
            pkgs.postgresql_18 # latest; pg_config + libpq + a server for the live tests
          ];

          # pg_query (libpg_query) and rusqlite build C via bindgen, which needs
          # libclang. mkShell's stdenv already provides a working wrapped C compiler.
          LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";

          shellHook = ''
            # bindgen drives libclang directly, bypassing the cc wrapper, so it does
            # not inherit the libc/compiler include paths (hence "sys/types.h not
            # found"). Feed it the wrapper's own cflags so headers resolve.
            export BINDGEN_EXTRA_CLANG_ARGS="$(< ${pkgs.stdenv.cc}/nix-support/libc-cflags) $(< ${pkgs.stdenv.cc}/nix-support/cc-cflags)"
            echo "zero-migrate devShell: $(rustc --version)"
          '';
        };
      }
    );
}
