/**
 * "How it works": the model explained for clients, the thesis panel and
 * developers. Prose is condensed from docs/research/MODEL_EXPLAINED.md and
 * AR_ANCHORING.md; every diagram and number comes from model_viz_data.json.
 *
 * This route is lazy-loaded, so Recharts only downloads when someone opens it.
 */
import { AnchoringDiagram } from "./AnchoringDiagram";
import { CubiCasaDiagram, MitUNetDiagram } from "./ArchitectureDiagrams";
import { ChartFigure } from "./ChartFigure";
import { PipelineDiagram } from "./PipelineDiagram";
import { viz } from "./vizData";
import styles from "./learn.module.css";

const SECTIONS = [
  { id: "summary", label: "In short" },
  { id: "pipeline", label: "The pipeline" },
  { id: "networks", label: "The two networks" },
  { id: "results", label: "What the runs show" },
  { id: "ar", label: "Keeping the model still in AR" },
  { id: "glossary", label: "Glossary" },
  { id: "faq", label: "Questions" },
  { id: "credits", label: "Credits" },
];

/** Plain version of viz.meta.note (which speaks of JSON keys) for the panel. */
const RESULTS_NOTE =
  "Every number below is copied from a saved output file of a notebook or test run, named under each chart, or was computed by running the project's code unchanged. Kaggle runs v3 to v8 use CubiCasa5k sample 6044 (an architectural drawing); v9 and the local runs use sample 10052 (a colourful plan), so the two groups are not directly comparable.";

const RESULT_GROUPS: { title: string; intro: string; ids: string[] }[] = [
  {
    title: "Finding rooms",
    intro: "How each notebook run improved, and how much the two networks agree.",
    ids: ["kaggle_run_evolution_rooms", "kaggle_run_consensus", "graded_consensus_per_room", "consensus_metric_comparison", "consensus_monotonicity"],
  },
  {
    title: "Cleaning up walls",
    intro: "Healing broken wall masks, measuring wall thickness, and tidying the traced walls.",
    ids: ["healing_components", "wall_thickness_tmed", "wall_postprocess_funnel", "gap_closure_per_plan"],
  },
  {
    title: "Robustness and output",
    intro: "Does the answer change with image size, and how big is the 3D model?",
    ids: ["resolution_invariance", "glb_output_size", "mitunet_published_metrics"],
  },
];

export function LearnPage() {
  const charts = new Map(viz.charts.map((c) => [c.id, c]));
  return (
    <div className={`page ${styles.page}`}>
      <header className="page-header">
        <div>
          <h1>How it works</h1>
          <p className="muted">From a picture of a floor plan to a building you can walk through.</p>
        </div>
      </header>

      <nav className={styles.toc} aria-label="On this page">
        <ol>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.label}</a>
            </li>
          ))}
        </ol>
      </nav>

      <section id="summary" className={styles.section}>
        <h2>In short</h2>
        <div className={styles.prose}>
          <p>
            PlanVisAR takes a picture of a floor plan and lets you stand inside it on your phone. Two published, pretrained neural
            networks read the image. <strong>MitUNet</strong> marks every pixel that looks like wall. The <strong>CubiCasa5k network</strong>{" "}
            gives a second opinion on where the rooms, doors and windows are.
          </p>
          <p>
            The system does not trace walls line by line. It finds the enclosed spaces (rooms) first and treats their borders as the walls,
            so every room in the 3D model is closed. It then compares its rooms with the second network&apos;s rooms: agreement counts as
            evidence, disagreement raises a flag. A final gate accepts the plan or rejects it with a clear reason, and a rejected plan never
            becomes a broken 3D model.
          </p>
          <p>
            An accepted plan becomes a small file of walls and rooms. The phone raises the walls into 3D and places them on the floor with
            ARCore. You type one real measurement, such as the building&apos;s longest side, and the whole model scales from that number.{" "}
            <strong>No new network was trained.</strong> The project&apos;s contribution is the geometry pipeline, the consensus check and the
            AR app built around existing models.
          </p>
        </div>
      </section>

      <section id="pipeline" className={styles.section}>
        <h2>The pipeline</h2>
        <PipelineDiagram />
      </section>

      <section id="networks" className={styles.section}>
        <h2>The two networks</h2>
        <div className={styles.twoUp}>
          <div>
            <h3>MitUNet: where the walls are</h3>
            <p className="small">{String(viz.architecture.models[0]?.role ?? "")}. Trained on CubiCasa5k; loss: Tversky.</p>
            <MitUNetDiagram />
          </div>
          <div>
            <h3>CubiCasa: rooms, doors and windows</h3>
            <p className="small">{String(viz.architecture.models[1]?.role ?? "")}.</p>
            <CubiCasaDiagram />
          </div>
        </div>
      </section>

      <section id="results" className={styles.section}>
        <h2>What the runs show</h2>
        <p className={`small muted ${styles.prose}`}>{RESULTS_NOTE}</p>
        {RESULT_GROUPS.map((g) => (
          <div key={g.title} className={styles.resultGroup}>
            <h3 className={styles.groupTitle}>{g.title}</h3>
            <p className="muted">{g.intro}</p>
            <div className={styles.chartGrid}>
              {g.ids.map((id) => {
                const c = charts.get(id);
                return c ? <ChartFigure key={id} chart={c} /> : null;
              })}
            </div>
          </div>
        ))}
      </section>

      <section id="ar" className={styles.section}>
        <h2>Keeping the model still in AR</h2>
        <div className={styles.twoUp}>
          <div className={styles.prose}>
            <p>
              Early versions drifted: the model seemed to slide as you walked. The phone did create an anchor where you tapped, but only the
              anchor&apos;s position was used and its heading was thrown away. At life size, walls sit up to 10 m from the anchor, so when ARCore
              corrected its sense of direction by even 2 degrees, the walls you were looking at moved by almost 30 cm.
            </p>
            <p>The fix, now in the app:</p>
            <ul>
              <li>The model follows the anchor&apos;s full pose, position and heading.</li>
              <li>Only real detected surfaces can be anchored; the quick preview ring cannot.</li>
              <li>
                The ring turns green, and Place unlocks, only when tracking is solid, the hit has been steady for 12 frames, and the phone has
                moved at least 30 cm so it has seen the room from more than one angle.
              </li>
              <li>If the phone loses position tracking, the model hides instead of following the camera.</li>
            </ul>
          </div>
          <AnchoringDiagram />
        </div>
      </section>

      <section id="glossary" className={styles.section}>
        <h2>Glossary</h2>
        <dl className={styles.glossary}>
          {viz.glossary.map((g) => (
            <div key={g.term}>
              <dt>{g.term}</dt>
              <dd>{g.def}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="faq" className={styles.section}>
        <h2>Questions</h2>
        <div className={styles.faq}>
          {viz.faq.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section id="credits" className={styles.section}>
        <h2>Credits</h2>
        <p>
          The 3D model&apos;s surfaces and fixtures are public-domain (CC0 1.0) assets, bundled with the app so they also work offline.
          Attribution is not required; it is given anyway.
        </p>
        <ul>
          <li>
            Wall plaster, oak floor, stone tile, concrete and door veneer textures: <a href="https://ambientcg.com">ambientCG</a> (Plaster001,
            WoodFloor051, Tiles139, Concrete034, Wood049), CC0 1.0.
          </li>
          <li>
            Door (with handle) and window models: Kenney <a href="https://kenney.nl/assets/furniture-kit">Furniture Kit</a>, CC0 1.0.
          </li>
        </ul>
        <p className="small muted">
          Full list with sources and changes: <a href="/textures/CREDITS.txt">textures/CREDITS.txt</a> and{" "}
          <a href="/models/CREDITS.txt">models/CREDITS.txt</a>.
        </p>
      </section>
    </div>
  );
}
