# editorjs-yjs - see `make help`.
#
# Everything here runs in Docker, so a clone plus `make demo` is enough; no
# local Node, no global installs, nothing to uninstall afterwards.

DOCKER      := docker compose
DEMO_PORT   ?= 8089
RELAY_PORT  ?= 1234

export DEMO_PORT
export DEMO_RELAY_PORT = $(RELAY_PORT)

C_OK    := \033[32m
C_INFO  := \033[36m
C_WARN  := \033[33m
C_DIM   := \033[2m
C_RESET := \033[0m

.DEFAULT_GOAL := help
.PHONY: help demo stop logs status build clean demo-local

## Show this help
help:
	@printf "$(C_INFO)editorjs-yjs$(C_RESET)\n\n"
	@printf "  $(C_OK)make demo$(C_RESET)    Start the live demo, then open $(C_INFO)http://localhost:$(DEMO_PORT)$(C_RESET)\n"
	@printf "  $(C_OK)make stop$(C_RESET)    Stop it and remove the containers\n"
	@printf "  $(C_OK)make logs$(C_RESET)    Follow the relay and server logs\n"
	@printf "  $(C_OK)make status$(C_RESET)  Show what is running\n"
	@printf "  $(C_OK)make build$(C_RESET)   Build the publishable package bundle into dist/\n"
	@printf "  $(C_OK)make clean$(C_RESET)   Remove containers, the node_modules volume and dist/\n\n"
	@printf "$(C_DIM)Ports: DEMO_PORT=$(DEMO_PORT) RELAY_PORT=$(RELAY_PORT)\n"
	@printf "If $(RELAY_PORT) is already taken, run: make demo RELAY_PORT=1235\n"
	@printf "and open http://localhost:$(DEMO_PORT)/?ws=ws://localhost:1235$(C_RESET)\n"

## Start the demo and print where to open it
demo:
	@printf "$(C_INFO)[demo]$(C_RESET) Starting relay and dev server (first run installs dependencies)...\n"
	@$(DOCKER) up -d --wait || { \
	   printf "$(C_WARN)[demo]$(C_RESET) Could not start. If a port is already taken, choose others:\n"; \
	   printf "         $(C_INFO)make demo RELAY_PORT=1235 DEMO_PORT=8090$(C_RESET)\n"; \
	   exit 1; \
	 }
	@printf "$(C_OK)[demo]$(C_RESET) Ready → $(C_INFO)http://localhost:$(DEMO_PORT)$(C_RESET)\n"
	@if [ "$(RELAY_PORT)" != "1234" ]; then \
	   printf "$(C_WARN)[demo]$(C_RESET) Relay is on $(RELAY_PORT), so open $(C_INFO)http://localhost:$(DEMO_PORT)/?ws=ws://localhost:$(RELAY_PORT)$(C_RESET) instead\n"; \
	 fi
	@printf "$(C_DIM)       Type in either pane; the other one follows. Logs: make logs$(C_RESET)\n"

## Stop the demo
stop:
	@$(DOCKER) down --remove-orphans
	@printf "$(C_OK)[demo]$(C_RESET) Stopped\n"

## Follow the logs
logs:
	@$(DOCKER) logs -f relay demo

## Show container status
status:
	@$(DOCKER) ps

## Build the publishable bundle into dist/
build:
	@printf "$(C_INFO)[build]$(C_RESET) Building dist/ ...\n"
	@$(DOCKER) run --rm --no-deps install sh -c "npm install --no-audit --no-fund --loglevel=error && npm run build"
	@printf "$(C_OK)[build]$(C_RESET) Done ✅\n"

## Remove containers, the dependency volume and build output
clean:
	@$(DOCKER) down --remove-orphans --volumes
	@rm -rf dist example/dist
	@printf "$(C_OK)[clean]$(C_RESET) Done ✅\n"

## Same demo without Docker, for anyone who already has Node
demo-local:
	@npm install --no-audit --no-fund
	@HOST=0.0.0.0 PORT=$(RELAY_PORT) node node_modules/y-websocket/bin/server.cjs & \
	 node_modules/.bin/esbuild example/client.js --bundle --format=iife \
	   --outfile=example/dist/bundle.js --servedir=example --serve=0.0.0.0:$(DEMO_PORT)
