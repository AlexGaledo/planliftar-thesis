/**
 * Image picker + camera capture + upload.
 *
 * Two inputs on purpose: `capture="environment"` makes phones open the rear
 * camera directly ("Take a photo"), while the plain input opens the file/gallery
 * picker. Desktop browsers ignore `capture`, so the camera button is only shown
 * on touch devices.
 *
 * Uses React Hook Form + Zod for the name/options fields; the file itself is
 * kept in state because file inputs are uncontrolled and we want a preview.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { ACCEPTED_IMAGE_TYPES, checkImageFile, usePlanApi } from "@/lib/api";
import { savePendingUpload } from "@/lib/db/pendingUploads";
import { UseDemoButton } from "./ServerStatus";
import styles from "./newProject.module.css";

const schema = z.object({
  name: z.string().trim().max(120, "Keep the name under 120 characters."),
  useCubicasa: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

export function ImageUploadForm() {
  const api = usePlanApi();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const { register, handleSubmit, setValue, getValues, formState } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", useCubicasa: true },
  });

  // Object URL for the preview; revoked when the file changes to free memory.
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const upload = useMutation({
    mutationFn: async (values: FormValues) => {
      if (!file) throw new Error("Choose an image first.");
      const { id } = await api.createJob(file, { use_cubicasa: values.useCubicasa });
      const name = values.name || file.name.replace(/\.[^.]+$/, "") || "New plan";
      await savePendingUpload(id, {
        name,
        image: file,
        fileName: file.name,
        demo: api.kind === "demo",
      });
      return id;
    },
    onSuccess: (id) => navigate(`/new/job/${encodeURIComponent(id)}`),
  });

  function pick(f: File | undefined) {
    if (!f) return;
    const problem = checkImageFile(f);
    setFileError(problem);
    setFile(problem ? null : f);
    if (!problem && !getValues("name")) setValue("name", f.name.replace(/\.[^.]+$/, ""));
  }

  const accept = ACCEPTED_IMAGE_TYPES.join(",");

  return (
    <form className="stack" onSubmit={handleSubmit((v) => upload.mutate(v))} noValidate>
      <div className={styles.dropzone} data-has-file={!!file}>
        {previewUrl ? (
          <img src={previewUrl} alt={`Preview of ${file?.name}`} className={styles.preview} />
        ) : (
          <p className="muted">
            PNG, JPEG or WebP, up to 15 MB. A straight-on photo or scan works best.
          </p>
        )}
        <div className="row">
          <label className="btn" htmlFor="image-input">
            {file ? "Choose a different image" : "Choose an image"}
          </label>
          {isTouch && (
            <label className="btn" htmlFor="camera-input">
              Take a photo
            </label>
          )}
        </div>
        <input
          id="image-input"
          className="visually-hidden"
          type="file"
          accept={accept}
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <input
          id="camera-input"
          className="visually-hidden"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {fileError && (
        <p className="notice notice-error" role="alert">
          {fileError}
        </p>
      )}

      <div className="field">
        <label htmlFor="project-name">Project name</label>
        <input
          id="project-name"
          className="input"
          placeholder="e.g. Santos residence, ground floor"
          {...register("name")}
          aria-invalid={!!formState.errors.name}
        />
        {formState.errors.name && (
          <span className="field-error">{formState.errors.name.message}</span>
        )}
      </div>

      <label className="check">
        <input type="checkbox" {...register("useCubicasa")} />
        <span>
          Ask a second AI model to check the rooms
          <span className="field-hint" style={{ display: "block" }}>
            Slower, but flags plans where the two models disagree.
          </span>
        </span>
      </label>

      {upload.isError && (
        <div className="notice notice-error" role="alert">
          <span>{(upload.error as Error).message}</span>
          {api.kind !== "demo" && (
            <span className="row">
              <UseDemoButton />
            </span>
          )}
        </div>
      )}
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={!file || upload.isPending}>
          {upload.isPending ? "Uploading…" : "Analyse plan"}
        </button>
      </div>
    </form>
  );
}
