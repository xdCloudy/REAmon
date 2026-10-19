# IDA Pro integration

REAmon can run IDA Pro's batch executable with its bundled IDAPython exporter. It uses the licensed IDA installation supplied by the deployment operator; REAmon does not download IDA, distribute its binaries, or require a vendor API key.

## Requirements and scope

- A licensed **Linux** IDA Pro installation on the machine running the REAmon Docker services.
- The batch executable (`idat` or `idat64`) and its IDAPython/Hex-Rays decompiler components.
- A read-only mount of that installation at `/opt/ida` inside the isolated `ida-analyzer` container.
- Enough memory, disk space, and an IDA license available to the container's runtime user.

The IDA path is read from **Settings → System** and must be `/opt/ida/idat` or `/opt/ida/idat64`. The browser cannot make a path on another LAN computer available to the analyzer. Windows executables such as `idat64.exe` cannot run in REAmon's Linux service; using an installation on a Windows client requires a separate native runner, which is not part of this integration.

## Enable the install mount

Set `REAMON_IDA_INSTALL_HOST_PATH` to the Linux IDA install directory, then start the webapp with the optional Compose overlay:

```bash
export REAMON_IDA_INSTALL_HOST_PATH=/opt/ida
docker compose --env-file .env -f docker-compose.yml -f docker-compose.ida.yml up -d --no-deps ida-analyzer webapp
```

In REAmon, save `/opt/ida/idat64` (or `/opt/ida/idat`) in **Settings → System → IDA Pro executable**. Select **IDA Pro Native Decompiler** in the analysis proposals to run it. Remove the setting to disable it. The executable is restricted to `/opt/ida`; request data is passed as process arguments and not through a shell.

The exporter preserves IDA pseudocode, disassembly, function addresses, call edges, and the exact source-artifact hash as separate project evidence. Pseudocode is labeled as a reconstruction rather than original source. Jobs are bounded to 1,200 functions, 96 MiB of combined code/disassembly output, and 30 minutes; larger analyses are marked truncated. Ghidra remains available as a separate provider.

## Current limits

The optional analyzer requires a compatible Linux IDA Pro install visible inside the isolated analyzer container. There is no automatic Windows host discovery, paired desktop runner, IDB import, type-library management, or accepted-name export back into an IDA database yet. Those should be added only with an explicit, hash-checked export workflow.
