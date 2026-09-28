# Preregistro T5 — falsación de H1–H4 de la caída de la «economía de hacer» (2026-09-27)

Rama `sprint/instr-t5-20260927`. Commiteado ANTES de lanzar la campaña. El script de evaluación
aplica EXACTAMENTE estas reglas (se prueba con datos sintéticos antes de ver los reales) y escribe
`/datos/tmp-atlas-lab/balance/veredicto-economia-hacer.json` + texto. Sin proponer ni implementar
leyes nuevas.

## Campaña

- Semillas NUEVAS 7001–7016 (verificadas ausentes en bitácora y `datos-lab/` el 27-09; los dos únicos
  «700x» en bitácora son fragmentos de SHA). Reglas 11 por defecto + `persistencia.cadaTicks=300`,
  límites del anfitrión por defecto (sin techo-lab ni overrides), instrumentos `si`, 60 días.
- Portátil (12 réplicas) + torre (4 réplicas). Deterministas, sin reanudación (incompleta ⇒ relanzar día 0).
- Código: punta de esta rama al lanzar (sha en bitácora; cada `replica.json` registra el suyo).

## Ventanas y validez (común)

- Temprana 5–14, media 26–35, tardía 51–60 (las del diagnóstico). Comparación primaria: temprana→media
  (la caída ocurre ~día 25); tardía solo descriptiva secundaria.
- Valor de ventana = mediana de los días válidos; ventana nula con <7/10 días válidos.
- `hacer` = fracciones persona-tick gather+build+craft+hunt (`repartoTiempoPorAccion`, días con
  personaTicks>0). Toda razón X_media/X_temprana con denominador 0 ⇒ semilla NO-APLICA en esa hipótesis.
- Veredicto por semilla: APOYA / REFUTA / NO-APLICA (fenómeno ausente o ventana nula; se reporta).
- Veredicto conjunto por hipótesis: REFUTADA si refuta ≥ 10 y refuta > 2×apoya; SOBREVIVE si
  apoya ≥ 10 y apoya > 2×refuta; si no, INCONCLUSA. Con <10 semillas válidas (apoya+refuta),
  INCONCLUSA por falta de datos.

## H1 — escasez local de madera/piedra

- Medida: G = fracción gather; S = Σ(madera+piedra)/ΣmiembrosVivos sobre comunidades con
  cobertura ≥ 0,9 (`ecoHacerStock`; día nulo si ninguna o sin miembros vivos).
- Predicción: el stock por miembro cae antes o con la caída de gather.
- Por semilla: REFUTA si G_media ≤ 0,8×G_temprana y S_media ≥ 0,8×S_temprana (gather cae ≥20 %
  con stock dentro del 20 %); APOYA si G_media ≤ 0,8×G_temprana y S_media < 0,8×S_temprana;
  si no, NO-APLICA.

## H2 — pérdida de oportunidad marginal de construir

- Medida: B = fracción build; R = rechazos.ganancia/evaluaciones (`ecoHacerConstruccion`, días con
  evaluaciones ≥ 20; resto nulos).
- Predicción: la proporción de rechazos por ganancia insuficiente sube mientras cae build.
- Por semilla: REFUTA si B_media ≤ 0,8×B_temprana y R_media < 1,2×R_temprana (con R_temprana = 0,
  subida = R_media > 0,05); APOYA si B_media ≤ 0,8×B_temprana y R_media ≥ 1,2×R_temprana (o > 0,05
  con base 0); si no, NO-APLICA. Reparto del resto de motivos, descriptivo.

## H3 — déficit de herramientas funcionales

- Medida: CG = fracción craft+gather; C = capacidadMedia (`ecoHacerHerramientas`; día nulo sin adultos).
- Predicción: el stock funcional por adulto cae antes o con la caída de craft+gather.
- Por semilla: REFUTA si CG_media ≤ 0,8×CG_temprana y C_media ≥ 0,8×C_temprana; APOYA si
  CG_media ≤ 0,8×CG_temprana y C_media < 0,8×C_temprana; si no, NO-APLICA. Desgaste y reposición,
  descriptivos secundarios.

## H4 — competencia temporal de acercamientos y reproducción

- Medida: H = fracción hacer; F = mediana de `ecoHacerCupo.fraccion`; A = elegidos.approach/decisiones
  (`ecoHacerDemanda`, días con decisiones > 0).
- Predicción: hacer cae cuando el cupo se llena y/o sube el tiempo en approach.
- Por semilla: REFUTA si H_media ≤ 0,8×H_temprana y F_media < 0,9 y A_media ≤ 1,2×A_temprana
  (con A_temprana = 0, subida = A_media > 0,02); APOYA si H_media ≤ 0,8×H_temprana y
  (F_media ≥ 0,9 o A_media > 1,2×A_temprana o > 0,02 con base 0); si no, NO-APLICA.
