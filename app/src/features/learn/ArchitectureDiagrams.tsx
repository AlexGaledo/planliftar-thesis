/**
 * Block diagrams of the two networks, drawn from architecture.blocks:
 *  - MitUNet as a "U": encoder going down on the left, decoder coming up on
 *    the right, skip connections across. Box width shrinks with resolution.
 *  - CubiCasa as an hourglass: a row of blocks whose height follows the
 *    feature-map size (wide, narrow in the middle, wide again).
 * Block details are in a list under each diagram (and in each box's title).
 */
import { viz, type ArchBlock } from "./vizData";
import styles from "./learn.module.css";

const blocks = viz.architecture.blocks;
const byId = (id: string) => blocks.find((b) => b.id === id)!;

/** MitUNet rows: [encoder id, decoder id] at the same resolution, top = full size. */
const U_ROWS: [string | null, string | null][] = [
  ["mit_input", "mit_head"],
  [null, "mit_d4"],
  ["mit_s1", "mit_d3"],
  ["mit_s2", "mit_d2"],
  ["mit_s3", "mit_d1"],
  ["mit_s4", null],
];

export function MitUNetDiagram() {
  const ids = new Set(blocks.filter((b) => b.model === "MitUNet").map((b) => b.id));
  return (
    <figure className={styles.diagram}>
      <div className={styles.uGrid} role="img" aria-label="MitUNet: a Mix-Transformer encoder shrinks the image in four stages; a U-Net decoder grows it back, with skip connections between matching sizes, ending in a one-channel wall probability map.">
        {U_ROWS.map(([enc, dec], depth) => (
          <div key={enc ?? dec} className={styles.uRow} style={{ ["--depth" as string]: depth }}>
            {enc && ids.has(enc) ? <Block block={byId(enc)} side="enc" /> : <span />}
            {/* a skip connection joins encoder and decoder at the same size */}
            <span className={enc && dec && enc !== "mit_input" ? styles.uSkip : undefined} aria-hidden="true">
              {enc && dec && enc !== "mit_input" ? "skip" : ""}
            </span>
            {dec && ids.has(dec) ? <Block block={byId(dec)} side="dec" /> : <span />}
          </div>
        ))}
      </div>
      <figcaption className="small muted">
        Encoder (left) goes down to 1/32 of the input size; the decoder (right) climbs back to full size. The skip connections pass fine
        detail across. Output: one wall probability per pixel.
      </figcaption>
      <BlockList model="MitUNet" />
    </figure>
  );
}

const HOURGLASS = ["cc_input", "cc_stem", "cc_enc", "cc_dec", "cc_head"];
/** Relative box height per block: follows the feature-map resolution. */
const HOURGLASS_SIZE: Record<string, number> = { cc_input: 1, cc_stem: 0.7, cc_enc: 0.35, cc_dec: 0.7, cc_head: 1 };

export function CubiCasaDiagram() {
  const heads = blocks.filter((b) => byId("cc_head").next.includes(b.id));
  return (
    <figure className={styles.diagram}>
      <div className={styles.hourglass} role="img" aria-label="CubiCasa network: an hourglass that shrinks the image and grows it back, then a head splits into 21 junction heatmaps, 12 room classes and 11 icon classes.">
        {HOURGLASS.map((id) => (
          <div key={id} className={styles.hgStep}>
            <div className={styles.hgBox} style={{ height: `${HOURGLASS_SIZE[id] * 120}px` }} title={byId(id).detail}>
              <span>{byId(id).label}</span>
            </div>
            <span className="small muted">{byId(id).shape}</span>
          </div>
        ))}
        <div className={styles.hgHeads}>
          {heads.map((h) => (
            <div key={h.id} className={styles.hgHead} title={h.detail}>
              {h.label}
            </div>
          ))}
        </div>
      </div>
      <figcaption className="small muted">
        One network, three outputs. The app uses its room map as a second opinion and its door and window icons to seal openings.
      </figcaption>
      <BlockList model="CubiCasa" />
    </figure>
  );
}

function Block({ block, side }: { block: ArchBlock; side: "enc" | "dec" }) {
  return (
    <div className={styles.block} data-side={side} title={block.detail}>
      <strong>{block.label}</strong>
      <span className="small">{block.shape}</span>
    </div>
  );
}

function BlockList({ model }: { model: string }) {
  return (
    <details className={styles.dataDetails}>
      <summary>Layer details</summary>
      <dl className={styles.blockList}>
        {blocks
          .filter((b) => b.model === model)
          .map((b) => (
            <div key={b.id}>
              <dt>
                {b.label} <span className="muted">({b.shape})</span>
              </dt>
              <dd>{b.detail}</dd>
            </div>
          ))}
      </dl>
    </details>
  );
}
