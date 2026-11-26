#!/usr/bin/env bash
# Publicación en la torre. --simular recorre los pasos sin ejecutar las acciones.
set -euo pipefail
umask 077
shopt -s nullglob

fallar() { printf 'publicar-v23.sh: %s\n' "$*" >&2; exit 1; }
uso='uso: publicar-v23.sh --simular [<sha> [AAAAMMDD]] | publicar-v23.sh <sha> <AAAAMMDD>'
simular=false
if [[ ${1-} == --simular ]]; then simular=true; shift; fi
if $simular; then [[ $# -le 2 ]] || fallar "$uso"; else [[ $# == 2 ]] || fallar "$uso"; fi

scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
git_local=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -c core.hooksPath=/dev/null)
repo=$("${git_local[@]}" -C "$scripts" rev-parse --show-toplevel)
git_repo=("${git_local[@]}" -C "$repo")
sha=$("${git_repo[@]}" rev-parse --verify --end-of-options "${1:-HEAD}^{commit}") || fallar 'el candidato no es un commit local'
fecha=${2:-$(date +%Y%m%d)}
[[ $fecha =~ ^[0-9]{8}$ ]] && [[ $(date -d "${fecha:0:4}-${fecha:4:2}-${fecha:6:2}" +%Y%m%d) == "$fecha" ]] || fallar 'fecha inválida; usa AAAAMMDD'

anexo=/datos/workspaces/personal/AtlasParaIsa-anexo
publicaciones=$anexo/publicaciones
release_v22=$anexo/worktrees/publico-v22
mundo_v22=$anexo/mundos/v21-20261124
respaldo_v22=/mnt/Data2/respaldos-atlas-v21
config_v22=a3bcbe4a205adbb17bf615eec522608cb0822b5a
release=$anexo/worktrees/publico-v23-$fecha
mundo=$anexo/mundos/v23-$fecha
respaldo=/mnt/Data2/respaldos-atlas-v23-$fecha
expediente=$publicaciones/v23-$fecha-rollback
unidades_instaladas=$HOME/.config/systemd/user
archivo_entorno=$HOME/.config/atlas-para-isa/publicacion-v23.env
override_v22=$unidades_instaladas/atlas-publico.service.d/zz-v22-rollback.conf
temporal=$publicaciones/tmp
dominio=https://atlas.humanizar.tech
unidades=(atlas-publico.service atlas-respaldo-publico.service atlas-respaldo-publico.timer atlas-respaldo-cinta.service atlas-respaldo-cinta.timer)
timers_respaldo=(atlas-respaldo-publico.timer atlas-respaldo-cinta.timer)
timers=("${timers_respaldo[@]}" atlas-vigilante.timer)
servicio=(systemctl --user)
http=(curl --disable --fail --silent --show-error --max-time 30 --proto '=https')

paso() {
  local texto=$1; shift
  printf '%s\n' "$texto"
  if ! $simular; then "$@"; fi
}

confirmar_instancia() {
  local release_esperado=$1 mundo_esperado=$2 pid fd
  pid=$("${servicio[@]}" show -P MainPID atlas-publico.service)
  [[ $pid =~ ^[1-9][0-9]*$ && $(readlink -f -- "/proc/$pid/cwd") == "$release_esperado" ]] || fallar "atlas-publico no ejecuta $release_esperado"
  for fd in /proc/"$pid"/fd/*; do
    if [[ $(readlink -- "$fd") == "$mundo_esperado/world.sqlite" ]]; then printf '%s\n' "$pid"; return; fi
  done
  fallar "atlas-publico no tiene abierto $mundo_esperado/world.sqlite"
}

preparar_expediente() {
  local nombre estado disponible ruta
  for nombre in bash node npm systemctl curl ss flock mountpoint sqlite3 gzip cmp rsync; do
    command -v "$nombre" >/dev/null || fallar "falta $nombre"
  done
  [[ -d $repo/node_modules ]] || fallar "falta $repo/node_modules"
  if ! "${git_repo[@]}" cat-file -e "$sha:scripts/publicar-v23.sh" ||
    ! "${git_repo[@]}" diff --quiet "$sha" -- scripts/deploy-check.sh scripts/publicar-v23.sh scripts/systemd/torre/; then
    fallar 'el candidato debe contener el procedimiento y las unidades de esta copia'
  fi
  for ruta in "$release" "$mundo" "$respaldo" "$expediente" "$archivo_entorno"; do
    [[ ! -e $ruta && ! -L $ruta ]] || fallar "la ruta debe ser nueva: $ruta"
  done
  mountpoint -q -- /mnt/Data2 || fallar '/mnt/Data2 no está montado'
  for ruta in "$anexo/mundos" /mnt/Data2; do
    disponible=$(df -PB1 -- "$ruta" | awk 'NR == 2 { print $4 }')
    [[ $disponible =~ ^[1-9][0-9]*$ ]] || fallar "no hay espacio disponible en $ruta"
    printf '%s bytes disponibles en %s\n' "$disponible" "$ruta"
  done
  exec 9<"$publicaciones"
  flock -n 9 || fallar 'ya hay una publicación en curso'
  confirmar_instancia "$release_v22" "$mundo_v22" >/dev/null
  mkdir -m 700 -- "$expediente"
  mkdir -m 700 -- "$expediente/unidades"
  "${git_repo[@]}" show "$config_v22:scripts/systemd/torre/publico.sh" > "$expediente/publico-v22.sh"
  bash -n "$expediente/publico-v22.sh"
  grep -Fxq "cd $release_v22" "$expediente/publico-v22.sh"
  grep -Fxq "export CARTA_DATA_DIR=$mundo_v22 HOST=100.64.0.1 PORT=3000" "$expediente/publico-v22.sh"
  printf '[Service]\nExecStart=\nExecStart=/usr/bin/bash %s/publico-v22.sh\n' "$expediente" > "$expediente/zz-v22-rollback.conf"
  : > "$expediente/timers-activos.txt"
  : > "$expediente/timers-habilitados-por-v23.txt"
  for nombre in "${unidades[@]}"; do
    ruta=$unidades_instaladas/$nombre
    if [[ -e $ruta || -L $ruta ]]; then cp -a -- "$ruta" "$expediente/unidades/"; fi
  done
  for nombre in "${timers[@]}"; do
    estado=$("${servicio[@]}" show -P ActiveState "$nombre")
    if [[ $estado == active ]]; then printf '%s\n' "$nombre" >> "$expediente/timers-activos.txt"; fi
  done
}

pausar_tareas() {
  local nombre
  confirmar_instancia "$release_v22" "$mundo_v22" >/dev/null
  corte=true
  for nombre in "${timers[@]}" atlas-vigilante.service atlas-respaldo-cinta.service; do
    if [[ $("${servicio[@]}" show -P LoadState "$nombre") != not-found ]]; then "${servicio[@]}" stop "$nombre"; fi
  done
}

respaldar_v22() {
  local copia marca ahora
  local -a copias=()
  marca=$(date +%Y%m%d-%H%M)
  if [[ -e $respaldo_v22/world-$marca.sqlite || -e $respaldo_v22/world-$marca.sqlite.gz ]]; then
    # El respaldo tiene resolución de un minuto y conserva la copia anterior.
    ahora=$(date +%s)
    sleep "$((61 - ahora % 60))"
  fi
  touch "$expediente/inicio-respaldo"
  "${servicio[@]}" start atlas-respaldo-publico.service
  for copia in "$respaldo_v22"/world-*.sqlite.gz; do
    if [[ -f $copia && $copia -nt $expediente/inicio-respaldo ]]; then copias+=("$copia"); fi
  done
  [[ ${#copias[@]} == 1 ]] || fallar "se esperaba una copia nueva en $respaldo_v22"
  # respaldo.sh comprueba PRAGMA quick_check antes de comprimir y publicar.
  gzip -t -- "${copias[0]}"
  printf '%s\n' "${copias[0]}" | tee "$expediente/respaldo-v22.txt"
}

parar_v22() {
  local pid_v22 escuchas
  pid_v22=$(confirmar_instancia "$release_v22" "$mundo_v22")
  "${servicio[@]}" stop atlas-publico.service
  [[ $("${servicio[@]}" show -P MainPID atlas-publico.service) == 0 ]] || fallar 'atlas-publico aún tiene un PID principal'
  if kill -0 "$pid_v22" 2>/dev/null; then fallar 'sigue vivo el proceso de V22'; fi
  escuchas=$(ss -H -ltn '( sport = :3000 )')
  [[ -z $escuchas ]] || fallar 'el puerto 3000 sigue ocupado'
}

construir() {
  "${git_repo[@]}" worktree add --detach "$release" "$sha"
  cp -a --reflink=auto -- "$repo/node_modules/." "$release/node_modules"
  (cd -- "$release" && npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null npm_config_offline=true npm run build)
  [[ -f $release/dist/client/index.html && -f $release/dist/server/server/main.js ]] || fallar 'faltan los entrypoints del build'
}

preparar_mundo() {
  mkdir -m 700 -- "$mundo" "$respaldo"
  mkdir -p -- "$temporal"
  install -m 600 -- "$mundo_v22/access.scrypt" "$mundo/access.scrypt"
}

instalar_unidades() {
  local nombre
  mkdir -p -- "$unidades_instaladas" "$(dirname -- "$archivo_entorno")"
  (
    set -o noclobber
    printf '%s\n' "CARTA_RELEASE_DIR=$release" "CARTA_DATA_DIR=$mundo" "DEST=$respaldo" \
      "CARTA_CINTA_RESPALDO=$respaldo/cinta" "TMPDIR=$temporal" "SQLITE_TMPDIR=$temporal" > "$archivo_entorno"
  )
  for nombre in "${unidades[@]}"; do
    install -T -m 644 -- "$release/scripts/systemd/torre/$nombre" "$unidades_instaladas/$nombre"
  done
  # Un intento nuevo también puede partir de V22 restaurada por el runbook.
  rm -f -- "$override_v22"
  "${servicio[@]}" daemon-reload
  for nombre in "${unidades[@]}"; do
    [[ $("${servicio[@]}" show -P FragmentPath "$nombre") == "$unidades_instaladas/$nombre" ]] ||
      fallar "systemd no cargó la unidad instalada: $nombre"
  done
}

verificar_dominio() {
  local cliente=$release/dist/client archivo recursos tick_durable
  sleep 60
  confirmar_instancia "$release" "$mundo" >/dev/null
  "${http[@]}" "$dominio/health" > "$expediente/health-inicial.json"
  "${http[@]}" "$dominio/" | cmp -s -- "$cliente/index.html" - || fallar 'el HTML del dominio difiere del build'
  recursos=$(node - "$cliente/index.html" <<'JS'
const fs = require('node:fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const recursos = [...html.matchAll(/\b(?:src|href)="(\/assets\/[\w.-]+\.(?:js|css))"/g)].map(m => m[1]);
if (!recursos.some(r => r.endsWith('.js'))) throw new Error('El HTML no contiene la entrada JS esperada');
console.log(recursos.join('\n'));
JS
)
  while IFS= read -r archivo; do
    "${http[@]}" "$dominio$archivo" | cmp -s -- "$cliente$archivo" - || fallar "el recurso servido difiere del build: $archivo"
  done <<< "$recursos"
  "${http[@]}" "$dominio/api/session" > "$expediente/session.json"
  sleep 5
  "${http[@]}" "$dominio/health" > "$expediente/health-final.json"
  tick_durable=$(sqlite3 -readonly -cmd '.timeout 5000' "$mundo/world.sqlite" \
    "SELECT COALESCE(json_extract(s.body,'\$.world.tick'),json_extract(s.body,'\$.tick')) FROM snapshots s JOIN snapshot_matter m ON m.slot=s.slot AND m.world_digest=s.digest WHERE s.slot=0 AND length(m.body)>0;")
  node - "$expediente" "$tick_durable" <<'JS'
const fs = require('node:fs');
const [dir, durable] = process.argv.slice(2);
const leer = nombre => JSON.parse(fs.readFileSync(`${dir}/${nombre}.json`, 'utf8'));
const [inicio, fin] = ['health-inicial', 'health-final'].map(leer);
for (const h of [inicio, fin]) {
  if (h.estado !== 'ok' || h.respaldo || !(h.ticksPorSegundo > 0) || h.recargas !== 0 ||
      h.diagnostico?.duras24h !== 0 || h.diagnostico?.blandas24h !== 0 ||
      h.diagnostico?.errorBitacora !== null || h.diagnostico?.registrosSinBitacora !== 0) {
    throw new Error('La salud por el dominio no cumple los criterios');
  }
}
if (!(fin.tick > inicio.tick && fin.epoca === inicio.epoca && fin.ultimoTickGuardado > 0 &&
      Number.isSafeInteger(Number(durable)) && Number(durable) >= fin.ultimoTickGuardado)) {
  throw new Error('No se confirmó avance y guardado durable con materia');
}
const sesion = leer('session');
if (sesion.authenticated !== false || !sesion.observerOnly || !sesion.tapeEnabled || !sesion.turbo) {
  throw new Error('Modo de acceso, observación, turbo o cinta inesperado');
}
console.log(`Dominio y guardado verificados: ticks ${inicio.tick} → ${fin.tick}, durable ${durable}.`);
JS
}

activar_timers() {
  local nombre estado
  for nombre in "${timers_respaldo[@]}"; do
    estado=$("${servicio[@]}" is-enabled "$nombre" 2>/dev/null || true)
    if [[ $estado != enabled && $estado != enabled-runtime ]]; then
      printf '%s\n' "$nombre" >> "$expediente/timers-habilitados-por-v23.txt"
      "${servicio[@]}" enable "$nombre"
    fi
    "${servicio[@]}" start "$nombre"
  done
  if grep -Fxq atlas-vigilante.timer "$expediente/timers-activos.txt"; then "${servicio[@]}" start atlas-vigilante.timer; fi
}

corte=false
al_salir() {
  local codigo=$?
  if ((codigo != 0)) && $corte; then
    printf 'El corte se inició. Revisa %s y sigue el rollback de docs/v23/PUBLICACION.md.\n' "$expediente" >&2
  fi
}
trap al_salir EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if $simular; then printf 'Simulación de la publicación V23\n'; fi
printf 'Candidato %s · fecha %s\n' "$sha" "$fecha"
paso "1. Verificar V22, espacio y rutas nuevas. Conservar unidades, timers y lanzador V22 en $expediente" preparar_expediente
paso "2. Ejecutar deploy-check sobre $sha y conservar el informe" bash "$scripts/deploy-check.sh" "$sha" "$expediente/deploy-check"
paso '3. Pausar los timers de respaldo y el vigilante de la torre durante el corte' pausar_tareas
paso "4. Respaldar V22 con atlas-respaldo-publico.service y verificar una copia nueva en $respaldo_v22" respaldar_v22
paso '5. Parar atlas-publico.service y verificar el PID y el puerto 3000' parar_v22
paso "6. Crear el worktree detached $release, copiar node_modules y construir allí" construir
paso "7. Crear el mundo $mundo, conservar el hash de acceso de V22 y preparar $respaldo" preparar_mundo
paso "8. Instalar las cinco unidades y $archivo_entorno. Ejecutar daemon-reload" instalar_unidades
paso '9. Arrancar atlas-publico.service' "${servicio[@]}" start atlas-publico.service
paso "10. Verificar salud, avance, archivos del build, sesión y guardado durable por $dominio" verificar_dominio
paso '11. Habilitar e iniciar los timers de respaldo y reanudar el vigilante si estaba activo' activar_timers
