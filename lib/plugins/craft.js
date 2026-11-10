const assert = require('assert')
const { once, onceWithCleanup } = require('../promise_utils')

// How long the result slot may trail the clicks that fill the grid.
const RESULT_TIMEOUT = 2000

module.exports = inject

function inject (bot) {
  const Item = require('prismarine-item')(bot.registry)
  const Recipe = require('prismarine-recipe')(bot.registry).Recipe
  let windowCraftingTable

  async function craft (recipe, count, craftingTable) {
    assert.ok(recipe)
    count = parseInt(count ?? 1, 10)
    if (recipe.requiresTable && !craftingTable) {
      throw new Error('Recipe requires craftingTable, but one was not supplied: ' + JSON.stringify(recipe))
    }

    try {
      for (let i = 0; i < count; i++) {
        await craftOnce(recipe, craftingTable)
      }

      if (windowCraftingTable) {
        // The last put-away click is unconfirmed; closing on a wrong model
        // leaves items the server never placed.
        await bot._syncWindow(windowCraftingTable)
        await bot.closeWindow(windowCraftingTable)
        windowCraftingTable = undefined
      }
    } catch (err) {
      if (windowCraftingTable) {
        bot.closeWindow(windowCraftingTable)
        windowCraftingTable = undefined
      }
      throw new Error(err)
    }
  }

  async function craftOnce (recipe, craftingTable) {
    if (craftingTable) {
      if (!windowCraftingTable) {
        bot.activateBlock(craftingTable)
        const [window] = await once(bot, 'windowOpen')
        windowCraftingTable = window
      }
      if (!windowCraftingTable.type.startsWith('minecraft:crafting')) {
        throw new Error('crafting: non craftingTable used as craftingTable: ' + windowCraftingTable.type)
      }
      await startClicking(windowCraftingTable, 3, 3)
    } else {
      await startClicking(bot.inventory, 2, 2)
    }

    async function startClicking (window, w, h) {
      const extraSlots = unusedRecipeSlots()
      let ingredientIndex = 0
      let originalSourceSlot = null
      let it
      if (recipe.inShape) {
        it = {
          x: 0,
          y: 0,
          row: recipe.inShape[0]
        }
        await clickShape()
      } else {
        await nextIngredientsClick()
      }

      function incrementShapeIterator () {
        it.x += 1
        if (it.x >= it.row.length) {
          it.y += 1
          if (it.y >= recipe.inShape.length) return null
          it.x = 0
          it.row = recipe.inShape[it.y]
        }
        return it
      }

      async function nextShapeClick () {
        if (incrementShapeIterator()) {
          await clickShape()
        } else if (!recipe.ingredients) {
          await putMaterialsAway()
        } else {
          await nextIngredientsClick()
        }
      }

      async function clickShape () {
        const destSlot = slot(it.x, it.y)
        const ingredient = it.row[it.x]
        if (ingredient.id === -1) return nextShapeClick()
        if (!window.selectedItem || window.selectedItem.type !== ingredient.id ||
          (ingredient.metadata != null &&
            window.selectedItem.metadata !== ingredient.metadata)) {
          // we are not holding the item we need. click it.
          const sourceItem = window.findInventoryItem(ingredient.id, ingredient.metadata)
          if (!sourceItem) throw new Error('missing ingredient')
          if (originalSourceSlot == null) originalSourceSlot = sourceItem.slot
          await bot.clickWindow(sourceItem.slot, 0, 0)
        }
        await bot.clickWindow(destSlot, 1, 0)
        await nextShapeClick()
      }

      async function nextIngredientsClick () {
        const ingredient = recipe.ingredients[ingredientIndex]
        const destSlot = extraSlots.pop()
        if (!window.selectedItem || window.selectedItem.type !== ingredient.id ||
          (ingredient.metadata != null &&
            window.selectedItem.metadata !== ingredient.metadata)) {
          // we are not holding the item we need. click it.
          const sourceItem = window.findInventoryItem(ingredient.id, ingredient.metadata)
          if (!sourceItem) throw new Error('missing ingredient')
          if (originalSourceSlot == null) originalSourceSlot = sourceItem.slot
          await bot.clickWindow(sourceItem.slot, 0, 0)
        }
        await bot.clickWindow(destSlot, 1, 0)
        if (++ingredientIndex < recipe.ingredients.length) {
          await nextIngredientsClick()
        } else {
          await putMaterialsAway()
        }
      }

      async function putMaterialsAway () {
        const start = window.inventoryStart
        const end = window.inventoryEnd
        await bot.putSelectedItemRange(start, end, window, originalSourceSlot)
        await grabResult()
      }

      async function grabResult () {
        assert.strictEqual(window.selectedItem, null)
        assert.ok(await bot._waitForCraftingResult(window, recipe.result),
          'Server did not supply the expected crafting result')
        const remaining = []
        let resultUpdates = 0
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const input = window.slots[slot(x, y)]
            assert.ok(!input || input.count === 1, 'Crafting grid must contain one item per ingredient slot')
            const remainder = recipe.outShape?.[y]?.[x]
            const item = remainder && remainder.id !== -1
              ? new Item(remainder.id, remainder.count, remainder.metadata ?? null)
              : null
            remaining.push({ slot: slot(x, y), item })
            // Vanilla ResultSlot.onTake removes each ingredient separately,
            // then sets each remainder. Every grid mutation recomputes and
            // sends the result slot, including intermediate empty results.
            resultUpdates += (input ? 1 : 0) + (item ? 1 : 0)
          }
        }
        // Taking the output also consumes its grid. Predict both in the same
        // click, before sending changedSlots, rather than correcting it later.
        await bot._takeCraftingResult(remaining, resultUpdates)
        await bot.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window, null)
        for (const { slot, item } of remaining) {
          if (item) await bot.putAway(slot)
        }
      }

      function slot (x, y) {
        return 1 + x + w * y
      }

      function unusedRecipeSlots () {
        const result = []
        let x
        let y
        let row
        if (recipe.inShape) {
          for (y = 0; y < recipe.inShape.length; ++y) {
            row = recipe.inShape[y]
            for (x = 0; x < row.length; ++x) {
              if (row[x].id === -1) result.push(slot(x, y))
            }
            for (; x < w; ++x) {
              result.push(slot(x, y))
            }
          }
          for (; y < h; ++y) {
            for (x = 0; x < w; ++x) {
              result.push(slot(x, y))
            }
          }
        } else {
          for (y = 0; y < h; ++y) {
            for (x = 0; x < w; ++x) {
              result.push(slot(x, y))
            }
          }
        }
        return result
      }
    }
  }

  function recipesFor (itemType, metadata, minResultCount, craftingTable) {
    minResultCount = minResultCount ?? 1
    const results = []
    Recipe.find(itemType, metadata).forEach((recipe) => {
      if (requirementsMetForRecipe(recipe, minResultCount, craftingTable)) {
        results.push(recipe)
      }
    })
    return results
  }

  function recipesAll (itemType, metadata, craftingTable) {
    const results = []
    Recipe.find(itemType, metadata).forEach((recipe) => {
      if (!recipe.requiresTable || craftingTable) {
        results.push(recipe)
      }
    })
    return results
  }

  function requirementsMetForRecipe (recipe, minResultCount, craftingTable) {
    if (recipe.requiresTable && !craftingTable) return false

    // how many times we have to perform the craft to achieve minResultCount
    const craftCount = Math.ceil(minResultCount / recipe.result.count)

    // false if not enough inventory to make all the ones that we want
    for (let i = 0; i < recipe.delta.length; ++i) {
      const d = recipe.delta[i]
      if (bot.inventory.count(d.id, d.metadata) + d.count * craftCount < 0) return false
    }

    // otherwise true
    return true
  }

  /**
   * Wait until the window's result slot shows the expected output. Vanilla
   * sends the recomputed result with each grid click, but Paper first echoes
   * slots it already sent, so the result can trail the click's own updates.
   * Clicks are applied in order server side, so a late result is still there.
   */
  async function waitForCraftingResult (window, expected) {
    const matches = () => {
      const result = window.slots[0]
      return !!result && result.type === expected.id && result.count === expected.count
    }
    if (matches()) return true
    await onceWithCleanup(window, 'updateSlot:0', { timeout: RESULT_TIMEOUT, checkCondition: matches })
      .catch(() => {})
    return matches()
  }

  bot.craft = craft
  bot._waitForCraftingResult = waitForCraftingResult
  bot.recipesFor = recipesFor
  bot.recipesAll = recipesAll
}
