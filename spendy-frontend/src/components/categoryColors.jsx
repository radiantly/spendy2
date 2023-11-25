const categoryColorsPalette = {
  Entertainment: { light: "#FFD1DC", dark: "#FF69B4" },
  Electronics: { light: "#D0F0C0", dark: "#3CB371" },
  Miscellaneous: { light: "#FFFFE0", dark: "#FFD700" },
  Food: { light: "#FFE4E1", dark: "#FF4500" },
  Transport: { light: "#E0FFFF", dark: "#20B2AA" },
  Groceries: { light: "#E6E6FA", dark: "#9370DB" },
  Fitness: { light: "#F0E68C", dark: "#FFA500" },
  Bills: { light: "#EEDD82", dark: "#BDB76B" },
};

// Function to get a color for a new category
const generateRandomColor = () => {
  const randomColor = Math.floor(Math.random() * 16777215).toString(16);
  return `#${randomColor}`;
};

// Stores the category-color mapping in memory
const categoryColors = {};

export const getCategoryColor = (category) => {
  if (categoryColors[category]) {
    return categoryColors[category];
  }

  // Use predefined colors if available
  if (categoryColorsPalette[category]) {
    categoryColors[category] = categoryColorsPalette[category];
    return categoryColorsPalette[category];
  }

  // Generate a new color for categories not in the predefined list
  const newColor = generateRandomColor();
  categoryColors[category] = { light: newColor, dark: newColor }; // Use the same color for both for simplicity
  return { light: newColor, dark: newColor };
};
