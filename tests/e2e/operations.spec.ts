import { expect, test } from "@playwright/test";

test("citizen report becomes a verified, assigned incident in Supabase", async ({ page, request }) => {
  const unique = Date.now().toString(36);
  const description = `E2E Supabase ${unique}: asap tebal terlihat dari permukiman.`;
  const teamName = `Tim E2E ${unique}`;
  const pageErrors: string[] = [];
  const localServerErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const url = response.url();
    if (
      url.startsWith("http://127.0.0.1:3000/") &&
      response.status() >= 500 &&
      !url.includes("/api/hotspots")
    ) {
      localServerErrors.push(`${response.status()} ${url}`);
    }
  });

  const submitted = await request.post("/api/reports", {
    data: {
      lat: -2.2096,
      lon: 113.9213,
      description,
      submitterToken: `e2e-${unique}-citizen-token`,
    },
  });
  expect(submitted.status()).toBe(201);

  await page.goto("/incidents");
  await expect(page).toHaveURL(/\/officer-login\?next=/);
  await page.getByLabel("Email").fill("officer@firewatch.local");
  await page.getByLabel("Kata sandi").fill("FireWatchLocal123!");
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/incidents$/);
  await expect(page.getByRole("heading", { name: "Operasi Insiden" })).toBeVisible();

  await page.goto("/citizen-reports");
  await expect(page.getByRole("heading", { name: "Laporan Warga", exact: true })).toBeVisible();
  const reportRow = page.locator("tbody tr").filter({ hasText: description });
  await expect(reportRow).toBeVisible();
  await reportRow.click();
  await expect(page.getByText(description, { exact: true }).first()).toBeVisible();
  const reviewPanel = page.getByRole("button", { name: "Simpan status" }).locator("..");
  await reviewPanel.locator("select").selectOption("verified");
  await reviewPanel.locator("textarea").fill("Bukti dan lokasi laporan warga telah diperiksa petugas lokal.");
  await page.getByRole("button", { name: "Simpan status" }).click();
  await expect(page.getByText(/Status diperbarui menjadi "Terverifikasi"/)).toBeVisible();

  await page.goto("/incidents");
  const candidate = page.locator("div").filter({ hasText: description }).filter({ has: page.getByRole("button", { name: "Buka insiden" }) }).last();
  await expect(candidate).toBeVisible();
  await candidate.getByRole("button", { name: "Buka insiden" }).click();
  await expect(page.getByText(description, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Tambah tim" }).click();
  await page.getByPlaceholder("Nama tim").fill(teamName);
  await page.getByPlaceholder("Wilayah mandat").fill("Kalimantan Tengah");
  await page.getByPlaceholder("Nama ketua").fill("Komandan E2E");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByText(teamName, { exact: true })).toBeVisible();

  const verificationForm = page.locator("form").filter({ hasText: "1. Verifikasi manusia" });
  await verificationForm.locator("select").selectOption("confirmed");
  await verificationForm.locator("textarea").fill("Bukti warga telah dikonfirmasi melalui pemeriksaan manusia.");
  const verificationRefresh = page.waitForResponse(
    (response) => response.url().includes("/api/operations/notifications") && response.request().method() === "GET"
  );
  await verificationForm.getByRole("button", { name: "Simpan verifikasi" }).click();
  await verificationRefresh;
  await expect(page.getByText("Bukti warga telah dikonfirmasi melalui pemeriksaan manusia.")).toBeVisible();

  const priorityForm = page.locator("form").filter({ hasText: "2. Prioritas manual" });
  await priorityForm.locator("select").selectOption("high");
  await priorityForm.locator("textarea").fill("Asap dekat permukiman memerlukan respons lapangan berprioritas tinggi.");
  const priorityRefresh = page.waitForResponse(
    (response) => response.url().includes("/api/operations/notifications") && response.request().method() === "GET"
  );
  await priorityForm.getByRole("button", { name: "Simpan prioritas" }).click();
  await priorityRefresh;
  await expect(page.getByText("Asap dekat permukiman memerlukan respons lapangan berprioritas tinggi.")).toBeVisible();

  const assignmentForm = page.locator("form").filter({ hasText: "3. Penugasan tim" });
  await assignmentForm.locator("select").selectOption({ label: `${teamName} · Kalimantan Tengah` });
  await assignmentForm.locator("textarea").fill("Tim lokal ditugaskan untuk pemeriksaan dan koordinasi lapangan.");
  const assignmentRefresh = page.waitForResponse(
    (response) => response.url().includes("/api/operations/notifications") && response.request().method() === "GET"
  );
  await assignmentForm.getByRole("button", { name: "Tugaskan tim" }).click();
  await assignmentRefresh;
  await expect(page.getByText("Tim lokal ditugaskan untuk pemeriksaan dan koordinasi lapangan.")).toBeVisible();

  const progressForm = page.locator("form").filter({ hasText: "4. Progres penanganan" });
  await progressForm.locator("select").selectOption("in_progress");
  await progressForm.locator("textarea").fill("Tim sudah bergerak dan penanganan lapangan sedang berlangsung.");
  const progressRefresh = page.waitForResponse(
    (response) => response.url().includes("/api/operations/notifications") && response.request().method() === "GET"
  );
  await progressForm.getByRole("button", { name: "Perbarui progres" }).click();
  await progressRefresh;
  await expect(page.getByText("Tim sudah bergerak dan penanganan lapangan sedang berlangsung.")).toBeVisible();
  await expect(page.getByText(new RegExp(`ditugaskan ke ${teamName}`)).first()).toBeVisible();

  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport + 1);
  expect(pageErrors).toEqual([]);
  expect(localServerErrors).toEqual([]);

  await page.evaluate(() => fetch("/api/officer/logout", { method: "POST" }));
  await page.goto("/incidents");
  await expect(page).toHaveURL(/\/officer-login\?next=/);
});
