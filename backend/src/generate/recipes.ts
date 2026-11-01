import { HttpError } from "../http";
import { now, type Store } from "../store";
import type { GenRecipeRow } from "../types";
import { validateRecipe, type Recipe, type RecipeCheck } from "./recipe";
import { STEPS } from "./steps";
import { STEP_TYPES } from "./steps/schema";

// The recipe book: what the recipe editor and `sorot gen recipe` read and write. Examples that ship
// with Sorot are read-only (copy them to change them); a user recipe is validated on every save.

/** The step library: each type's settings schema, defaults and gate options (drives the editor's forms). */
export function stepLibrary() {
  return STEP_TYPES.map((type) => {
    const m = STEPS[type];
    return { type, gates: m.spec.gates, fields: m.spec.fields, required: m.spec.required ?? [], defaults: m.defaults };
  });
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function mustValid(recipe: unknown): Recipe {
  const check = validateRecipe(recipe);
  if (!check.ok) throw new HttpError(400, `The recipe isn't valid: ${check.errors.join("; ")}`);
  return recipe as Recipe;
}

export class RecipeBook {
  constructor(private readonly store: Store) {}

  /** Checks a recipe and saves nothing. */
  validate(recipe: unknown): RecipeCheck {
    return validateRecipe(recipe);
  }

  list(): GenRecipeRow[] {
    return this.store.listGenRecipes();
  }

  get(id: string): GenRecipeRow {
    const row = this.store.getGenRecipe(id);
    if (!row) throw new HttpError(404, `Recipe not found: ${id}`);
    return row;
  }

  private insert(recipe: Recipe, description: string | null): GenRecipeRow {
    const t = now();
    const row: GenRecipeRow = {
      id: recipe.id, name: recipe.name, version: 1, builtIn: 0, description, ideaCursor: null,
      recipe: JSON.stringify({ ...recipe, builtIn: false, version: 1 }), createdAt: t, updatedAt: t,
    };
    this.store.saveGenRecipe(row);
    return row;
  }

  private mustBeFree(id: unknown): string {
    if (typeof id !== "string" || !SLUG.test(id)) throw new HttpError(400, "The recipe id is lowercase letters, digits and dashes (at most 64)");
    if (this.store.getGenRecipe(id)) throw new HttpError(409, `A recipe with the id ${id} exists already`);
    return id;
  }

  /** A copy to edit: built-in examples are copied, never edited. */
  copy(fromId: string, id: unknown, name: unknown): GenRecipeRow {
    const from = JSON.parse(this.get(fromId).recipe) as Recipe;
    const newId = this.mustBeFree(id);
    if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "Give the copy a name");
    return this.insert({ ...from, id: newId, name: name.trim() }, from.description ?? null);
  }

  update(id: string, input: unknown): GenRecipeRow {
    const row = this.get(id);
    if (row.builtIn) throw new HttpError(409, "An example recipe can't be edited: copy it first");
    const recipe = mustValid(input);
    if (recipe.id !== id) throw new HttpError(400, "The recipe's id can't change");
    const version = row.version + 1;
    this.store.updateGenRecipe(id, { name: recipe.name, description: recipe.description ?? null, version, recipe: JSON.stringify({ ...recipe, builtIn: false, version }) });
    return this.get(id);
  }

  remove(id: string): void {
    const row = this.get(id);
    if (row.builtIn) throw new HttpError(409, "An example recipe can't be deleted");
    this.store.deleteGenRecipe(id);
  }

  /**
   * A shared recipe, checked like any other. It only ever *names* commands and connections: those
   * live in the importer's Settings, so importing can't run anything they didn't set up.
   */
  import(input: unknown): GenRecipeRow {
    const recipe = mustValid(input);
    this.mustBeFree(recipe.id);
    return this.insert(recipe, recipe.description ?? null);
  }

  export(id: string): Recipe {
    const { builtIn: _builtIn, ...rest } = JSON.parse(this.get(id).recipe) as Recipe;
    return rest as Recipe;
  }
}
