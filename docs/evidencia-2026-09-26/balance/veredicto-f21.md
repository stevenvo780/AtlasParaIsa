# Veredicto F2.1 — día 60

Fecha de corte: 2026-09-27T12:09:51-05:00.

Fuente: bitácora del laboratorio, 23-09 17:40; PUB2 sin techo frente a l60v3/B con techo 100.
Predicción direccional preregistrada: **refutada**. PUB2 mayor en 4/8; 0 semilla(s) indeterminada(s).

Predicción conjunta: **refutada**. la dirección se mide; reproduccionActivaFraccion=1 en PUB2 se infiere del modo congelado y no tiene observación diaria.

Atribución causal al techo: **no_identificada**. PUB2 y B tienen SHA, digest de código y parámetros distintos; la concordancia inicial de métricas no demuestra equivalencia dinámica.

| Semilla | Fuente PUB2 | Sen PUB2 | Sen B | Diferencia | Mayor | Repro B global | Repro B día 60 |
|---:|:---|---:|---:|---:|:---:|---:|---:|
| 5 | f21b-portatil | -0.05967155160220013 | 0.021167081246611257 | -0.08083863284881139 | False | 0.5423541666666667 | 0.06583333333333333 |
| 29 | f21b-portatil | -0.054941750933347966 | -0.023469972297561936 | -0.03147177863578603 | False | 0.356125 | 0.08541666666666667 |
| 101 | f21b-portatil | -0.04044687186902763 | 0.03658694683755528 | -0.07703381870658291 | False | 0.4752638888888889 | 0.18458333333333332 |
| 202 | f21b-portatil | -0.03590812896781377 | -0.08821196564110323 | 0.05230383667328946 | True | 0.4086666666666667 | 0.1225 |
| 404 | f21b-portatil | -0.12216075574620334 | -0.1328316248477546 | 0.010670869101551253 | True | 0.419125 | 0.14458333333333334 |
| 505 | f21b-portatil | -0.01821150792046163 | -0.06213472750081158 | 0.04392321958034995 | True | 0.8223055555555555 | 0.09416666666666666 |
| 606 | f21b-torre | -0.0515733389052328 | -0.08718244547073642 | 0.03560910656550362 | True | 0.5661666666666667 | 0.034583333333333334 |
| 707 | f21b-torre | -0.11829416008254104 | -0.09814158066216845 | -0.020152579420372588 | False | 0.3697916666666667 | 0.03958333333333333 |

Procedencia de los pares (SHA-256 de los bytes de `replica.json`):

- Semilla 5: PUB2 `749eff9d6756d40e304e7c9f948f34a33270bd2fb285eaf5914b7cdda6272358`; B `3de776f4f4f6c80e2ab063fd0a0038b376d99a467050cf3aca1e488b7d3e18a4`.
- Semilla 29: PUB2 `83161ced777cc53dd250f69b57bce08685182766fefc7245d0578358185d87d9`; B `cd09231eef40d268c3b3a644b50f39b7d72dd68eb4f001d1128fbc7ebda0458b`.
- Semilla 101: PUB2 `56acc3e90fc732309fd6ad80c6b3225e7f33e9c68aaf995b26b91f24e76fc921`; B `fe4d7e1d59cd404b3a8205cb1470113ac21f6d0aaf8c0e222675d68dfae91b1a`.
- Semilla 202: PUB2 `75b3c3de0d53f378aa67e67429e5f392dc31be6ec5c3520deb235f8149b432ad`; B `64496442530dfeb46f64fb1139cfed2dedb218d69388a335aad89b0ef54bca93`.
- Semilla 404: PUB2 `306713f7292df3f8d8cbd4ec5a7c1c8737e723f063d5df07e7d19b33e44e4cb4`; B `23146cf5233b72d5cb15fd9d84bf9b7f8d41098f3fda93c38a94627812323163`.
- Semilla 505: PUB2 `f13ebac90006726baf61b2b39f9f740558b9bd2430a8893b8311665e2d099a4e`; B `2c45139b9218e41d83bb5851bf3dc4f324bb163ed9467c3558588569cb420afb`.
- Semilla 606: PUB2 `6180a3e9a20a0a4a2b9d6eb4613712292854c752f8669d698fe2cb36eec62b7c`; B `4117332465b016c30bfb20102dae9a72a9693540edd441e24dddeb2eaffe21ed`.
- Semilla 707: PUB2 `306caef766aca96d6eb48830645fbc9caf2fb0ae61d29f2079a3788d44e1309b`; B `ba0f421af27efcadc0e196cda1b2e9b63246c997863c2a5841f8c44f24892d88`.

La subida es la mediana de todas las pendientes entre pares de días 5..60, multiplicada por 55; empates de la serie a tolerancia 1e-9 siguen el evaluador congelado. La comparación es estricta (>); no se redondea para decidir.
Un día con diversidad null o sin vecinos mortales deja esa semilla indeterminada; no se interpola.
PUB2 no registra `reproduccionActivaFraccion`: 1 se deduce del modo sin gobernador ni techo. No es una medición ni una prueba empírica de esa conjunción del prerregistro. B sí la registra.
El contraste pareado responde a la predicción direccional. Con SHA o parámetros distintos no identifica el efecto aislado del techo.
Las diferencias exactas de SHA y parámetros, poblaciones, nacimientos y el primer día de divergencia observable constan en el JSON. Una coincidencia de métricas antes de ese día no demuestra equivalencia del estado interno.

Comparación de código 1710b35 → d2ebf11: 26 archivos cambiados en `src/world/` e instrumentos; lista en JSON.
