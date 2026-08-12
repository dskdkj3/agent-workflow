{
  description = "Minimal Codex agent workflow MCP";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable-small";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          buildNpmPackageForNode24 = pkgs.buildNpmPackage.override {
            nodejs = pkgs.nodejs_24;
          };
        in
        rec {
          agent-workflow = buildNpmPackageForNode24 {
            pname = "agent-workflow";
            version = "0.1.0";
            src = self;

            npmDepsHash = "sha256-CSaGBxO/qztAtcWFJCHCIA7bouMmksu8NKAXBV/OEzM=";
            npmBuildScript = "build";

            doCheck = true;
            checkPhase = ''
              runHook preCheck
              npm test
              runHook postCheck
            '';

            nativeBuildInputs = [
              pkgs.gitMinimal
              pkgs.makeWrapper
            ];
            installPhase = ''
              runHook preInstall

              npm prune --omit=dev
              install -d "$out/lib/agent-workflow" "$out/bin"
              cp -R dist node_modules package.json "$out/lib/agent-workflow/"
              makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/agent-workflow-mcp" \
                --add-flags "$out/lib/agent-workflow/dist/server.js" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.gitMinimal ]}

              runHook postInstall
            '';

            meta = {
              description = "Minimal Codex Orchestrator, Worker, and Verifier MCP workflow";
              homepage = "https://github.com/dskdkj3/agent-workflow";
              mainProgram = "agent-workflow-mcp";
              platforms = systems;
            };
          };

          default = agent-workflow;
        }
      );

      checks = forAllSystems (system: {
        agent-workflow = self.packages.${system}.agent-workflow;
      });

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
